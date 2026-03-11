import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphNode } from "../../model/graph.js";
import { Context } from "../../state/context.js";
import { applyFidelity, resolveEffectiveFidelity } from "../../state/fidelity.js";
import type { Outcome } from "../../state/types.js";
import { failOutcome } from "../../state/types.js";
import type { CodergenBackend } from "../types.js";

export type StructuredObject = Record<string, unknown>;

interface StructuredBackendSuccess {
  stageDir: string;
  prompt: string;
  responseText: string;
  data: StructuredObject;
}

interface StructuredBackendFailure {
  stageDir: string;
  outcome: Outcome;
}

export type StructuredBackendResult = StructuredBackendSuccess | StructuredBackendFailure;

export async function executeStructuredBackend(
  node: GraphNode,
  context: Context,
  graph: Graph,
  logsRoot: string,
  backend: CodergenBackend | null,
  prompt: string,
): Promise<StructuredBackendResult> {
  const stageDir = path.join(logsRoot, node.id);
  fs.mkdirSync(stageDir, { recursive: true });

  if (!backend) {
    const outcome = failOutcome(`${node.type} requires a configured backend`);
    writeStatus(stageDir, outcome);
    return { stageDir, outcome };
  }

  const edgeFidelity = context.getString("internal.incoming_edge_fidelity");
  const fidelityMode = resolveEffectiveFidelity(
    edgeFidelity,
    node.fidelity,
    graph.attrs.defaultFidelity,
  );
  const filteredSnapshot = applyFidelity(context.snapshot(), fidelityMode);
  const filteredContext = Context.fromSnapshot(filteredSnapshot);
  const promptWithContext = fidelityMode !== "full"
    ? [synthesizePreamble(filteredSnapshot), prompt].filter(Boolean).join("\n\n")
    : prompt;

  fs.writeFileSync(path.join(stageDir, "prompt.md"), promptWithContext);

  try {
    const result = await backend.run(node, promptWithContext, filteredContext);
    if (typeof result === "object" && result !== null && "status" in result) {
      const outcome = result as Outcome;
      writeStatus(stageDir, outcome);
      return { stageDir, outcome };
    }

    const responseText = String(result);
    fs.writeFileSync(path.join(stageDir, "response.txt"), responseText);
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      const outcome = failOutcome(`${node.type} returned invalid JSON`);
      writeStatus(stageDir, outcome);
      return { stageDir, outcome };
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      const outcome = failOutcome(`${node.type} returned a non-object JSON payload`);
      writeStatus(stageDir, outcome);
      return { stageDir, outcome };
    }

    return {
      stageDir,
      prompt: promptWithContext,
      responseText,
      data: data as StructuredObject,
    };
  } catch (err) {
    const outcome = failOutcome(String(err));
    writeStatus(stageDir, outcome);
    return { stageDir, outcome };
  }
}

export function writeStatus(stageDir: string, outcome: Outcome): void {
  const data = {
    outcome: outcome.status,
    preferred_next_label: outcome.preferredLabel ?? "",
    suggested_next_ids: outcome.suggestedNextIds ?? [],
    context_updates: outcome.contextUpdates ?? {},
    notes: outcome.notes ?? "",
  };
  fs.writeFileSync(
    path.join(stageDir, "status.json"),
    JSON.stringify(data, null, 2),
  );
}

export function synthesizePreamble(snapshot: Record<string, unknown>): string {
  const entries = Object.entries(snapshot).filter(
    ([key]) => !key.startsWith("internal."),
  );
  if (entries.length === 0) return "";

  const lines = entries.map(([key, value]) => {
    const v = value === "" ? "(empty)" : String(value);
    return `- ${key}: ${v}`;
  });
  return "## Context from previous stages\n" + lines.join("\n");
}
