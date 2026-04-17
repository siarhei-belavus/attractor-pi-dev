import path from "node:path";
import type { Graph } from "./model/graph.js";

export const WORKFLOW_BASE_DIR_TOKEN = "${workflow_base_dir}";
export const RUN_ROOT_TOKEN = "${run_root}";

const WORKFLOW_BASE_DIR_METADATA_KEY = "_workflowBaseDir";
const WORKFLOW_PATH_ISSUES_KEY = "_workflowPathIssues";

type WorkflowPathAttr = "backend_setup" | "cwd";
export type RuntimePathToken =
  | typeof WORKFLOW_BASE_DIR_TOKEN
  | typeof RUN_ROOT_TOKEN;

export interface RuntimePathExpression {
  raw: string;
  token: RuntimePathToken;
  suffix: string;
}

export interface WorkflowPathIssue {
  nodeId: string;
  attr: WorkflowPathAttr;
  message: string;
}

export function parseRuntimePathExpression(value: string): RuntimePathExpression | null {
  const match = /^(\$\{[a-z_]+\})(\/.*)?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const token = match[1];
  if (token !== WORKFLOW_BASE_DIR_TOKEN && token !== RUN_ROOT_TOKEN) {
    return null;
  }
  return {
    raw: value,
    token,
    suffix: match[2] ?? "",
  };
}

export function resolveRuntimePathExpression(
  expression: RuntimePathExpression,
  values: Partial<Record<RuntimePathToken, string>>,
): string {
  const base = values[expression.token];
  if (!base) {
    throw new Error(`Missing runtime base for token '${expression.token}'`);
  }
  return expression.suffix ? path.resolve(base, `.${expression.suffix}`) : path.resolve(base);
}

export function attachWorkflowPathMetadata(
  graph: Graph,
  input: { dotFilePath?: string; workflowBaseDir?: string },
): Graph {
  const workflowBaseDir = resolveWorkflowBaseDir(input);
  const issues: WorkflowPathIssue[] = [];

  for (const node of graph.nodes.values()) {
    collectIssues(node.id, "backend_setup", node.attrs["backend_setup"], workflowBaseDir, issues);
    collectIssues(node.id, "cwd", node.attrs["cwd"], workflowBaseDir, issues);
  }

  graph.attrs[WORKFLOW_BASE_DIR_METADATA_KEY] = workflowBaseDir;
  graph.attrs[WORKFLOW_PATH_ISSUES_KEY] = issues;
  return graph;
}

export function getPreparedWorkflowBaseDir(graph: Graph): string | null {
  const value = graph.attrs[WORKFLOW_BASE_DIR_METADATA_KEY];
  return typeof value === "string" ? value : null;
}

export function getWorkflowPathIssues(graph: Graph): WorkflowPathIssue[] {
  const value = graph.attrs[WORKFLOW_PATH_ISSUES_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isWorkflowPathIssue);
}

function resolveWorkflowBaseDir(input: { dotFilePath?: string; workflowBaseDir?: string }): string | null {
  if (input.dotFilePath) {
    return path.dirname(path.resolve(input.dotFilePath));
  }
  if (input.workflowBaseDir) {
    return path.resolve(input.workflowBaseDir);
  }
  return null;
}

function collectIssues(
  nodeId: string,
  attr: WorkflowPathAttr,
  value: unknown,
  workflowBaseDir: string | null,
  issues: WorkflowPathIssue[],
): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (typeof value !== "string") {
    issues.push({
      nodeId,
      attr,
      message: `Node attr '${attr}' must be a string runtime path expression`,
    });
    return;
  }

  const expression = parseRuntimePathExpression(value);
  if (!expression) {
    issues.push({
      nodeId,
      attr,
      message:
        `Node attr '${attr}' must use reserved runtime tokens only; bare relative and absolute paths are invalid`,
    });
    return;
  }

  const allowedTokens =
    attr === "backend_setup"
      ? [WORKFLOW_BASE_DIR_TOKEN]
      : [WORKFLOW_BASE_DIR_TOKEN, RUN_ROOT_TOKEN];
  if (!allowedTokens.includes(expression.token)) {
    issues.push({
      nodeId,
      attr,
      message:
        attr === "backend_setup"
          ? `Node attr 'backend_setup' only supports ${WORKFLOW_BASE_DIR_TOKEN}`
          : `Node attr 'cwd' only supports ${WORKFLOW_BASE_DIR_TOKEN} or ${RUN_ROOT_TOKEN}`,
    });
    return;
  }

  if (expression.token === WORKFLOW_BASE_DIR_TOKEN && !workflowBaseDir) {
    issues.push({
      nodeId,
      attr,
      message:
        `Node attr '${attr}' requires workflow_base_dir for string/API workflows that use ${WORKFLOW_BASE_DIR_TOKEN}`,
    });
  }
}

function isWorkflowPathIssue(value: unknown): value is WorkflowPathIssue {
  if (!value || typeof value !== "object") {
    return false;
  }
  const issue = value as Record<string, unknown>;
  return (
    typeof issue.nodeId === "string" &&
    (issue.attr === "backend_setup" || issue.attr === "cwd") &&
    typeof issue.message === "string"
  );
}
