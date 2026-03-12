import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphNode } from "../../model/graph.js";
import type { Context } from "../../state/context.js";

interface ResolvedPromptContextInput {
  selector: string;
  heading: string;
  value: unknown;
  missing: boolean;
}

interface PromptContextArtifactEntry {
  selector: string;
  heading: string;
  value: unknown;
  missing: boolean;
}

interface PromptContextArtifact {
  requestedSelectors: string[];
  resolvedInputs: PromptContextArtifactEntry[];
  missingSelectors: string[];
}

export interface PromptAssemblyResult {
  prompt: string;
  artifact: PromptContextArtifact | null;
}

const CONTEXT_SECTION_TITLE = "## Context From Previous Steps";
const CONTEXT_SECTION_INTRO =
  "The following artifacts were produced by earlier pipeline steps and are provided as workflow inputs for this stage.\nUse them as grounded context, but verify against the repository or direct tool inspection when accuracy matters.";

export function appendPromptContext(
  node: GraphNode,
  graph: Graph,
  context: Context,
  basePrompt: string,
): PromptAssemblyResult {
  if (node.contextKeys.length === 0) {
    return { prompt: basePrompt, artifact: null };
  }

  const resolvedInputs = node.contextKeys.map((selector) =>
    resolvePromptContextInput(selector, graph, context)
  );

  const sections = resolvedInputs.map((input) =>
    `### ${input.heading}\n\n${renderPromptContextValue(input.value, input.missing)}`
  );
  const block = [CONTEXT_SECTION_TITLE, "", CONTEXT_SECTION_INTRO, "", ...sections].join("\n");

  return {
    prompt: [basePrompt, block].filter(Boolean).join("\n\n"),
    artifact: {
      requestedSelectors: [...node.contextKeys],
      resolvedInputs: resolvedInputs.map((input) => ({
        selector: input.selector,
        heading: input.heading,
        value: input.value,
        missing: input.missing,
      })),
      missingSelectors: resolvedInputs.filter((input) => input.missing).map((input) => input.selector),
    },
  };
}

export function writePromptContextArtifact(stageDir: string, artifact: PromptContextArtifact | null): void {
  if (!artifact) return;
  fs.writeFileSync(
    path.join(stageDir, "context-inputs.json"),
    JSON.stringify(artifact, null, 2),
  );
}

function resolvePromptContextInput(
  selector: string,
  graph: Graph,
  context: Context,
): ResolvedPromptContextInput {
  const missing = !context.has(selector);
  const value = missing ? null : context.get(selector);
  return {
    selector,
    heading: resolvePromptContextHeading(selector, graph),
    value,
    missing,
  };
}

function resolvePromptContextHeading(selector: string, graph: Graph): string {
  if (!selector.startsWith("node.")) return selector;

  const [, nodeId, ...keyParts] = selector.split(".");
  if (!nodeId || keyParts.length === 0) return selector;

  const sourceNode = graph.nodes.get(nodeId);
  const sourceLabel = sourceNode?.label || nodeId;
  return `${sourceLabel}: ${keyParts.join(".")}`;
}

function renderPromptContextValue(value: unknown, missing: boolean): string {
  if (missing) return "<missing>";
  if (value === "") return "<empty>";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}
