import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  RUN_ROOT_TOKEN,
  WORKFLOW_BASE_DIR_TOKEN,
  parseRuntimePathExpression,
  resolveRuntimePathExpression,
  type BackendCallContext,
  type GraphNode,
} from "@attractor/core";
import type { ResourceLoader } from "@mariozechner/pi-coding-agent";

export interface BackendSetupSnapshot {
  cwd: string;
  backendSetupPath: string | null;
  backendSetupHash: string | null;
}

export interface BackendSetupContext {
  nodeId: string;
  backendExecutionRef: string;
  workflowBaseDir: string | null;
  cwd: string;
  mode: "create" | "reopen";
  runRoot: string;
  backendStateRoot: string;
  originalSetupRef: string | null;
  resolvedSetupPath: string | null;
}

export interface BackendSetupBuilder {
  setResourceLoader(loader: ResourceLoader): void;
  setInitialActiveTools(names: string[]): void;
}

export type BackendSetupCallback = (
  context: BackendSetupContext,
  builder: BackendSetupBuilder,
) => void | Promise<void>;

export interface ResolvedBackendBootstrap {
  backendExecutionRef: string;
  workflowBaseDir: string | null;
  backendStateRoot: string;
  originalSetupRef: string | null;
  resolvedSetupPath: string | null;
  setupCallback: BackendSetupCallback | null;
  snapshot: BackendSetupSnapshot;
}

export async function resolveCurrentBackendBootstrap(input: {
  node: GraphNode;
  backendExecutionRef: string;
  backendCallContext: BackendCallContext;
  defaultCwd: string;
}): Promise<ResolvedBackendBootstrap> {
  const resolvedCwd = resolveNodeCwd(input.node, input.backendCallContext, input.defaultCwd);
  const originalSetupRef = readStringAttr(input.node, "backend_setup");
  const resolvedSetupPath = resolveBackendSetupPath(
    input.node,
    input.backendCallContext,
  );
  const loadedSetup = resolvedSetupPath
    ? await loadBackendSetupModule({ resolvedSetupPath })
    : null;

  return {
    backendExecutionRef: input.backendExecutionRef,
    workflowBaseDir: input.backendCallContext.workflowBaseDir,
    backendStateRoot: ensureBackendStateRoot(
      input.backendCallContext.logsRoot,
      input.backendExecutionRef,
    ),
    originalSetupRef,
    resolvedSetupPath,
    setupCallback: loadedSetup?.callback ?? null,
    snapshot: {
      cwd: resolvedCwd,
      backendSetupPath: resolvedSetupPath,
      backendSetupHash: loadedSetup?.hash ?? null,
    },
  };
}

export async function loadBackendBootstrapFromSnapshot(input: {
  snapshot: BackendSetupSnapshot;
  backendExecutionRef: string;
  runRoot: string;
  workflowBaseDir?: string | null;
  originalSetupRef?: string | null;
}): Promise<ResolvedBackendBootstrap> {
  const loadedSetup = input.snapshot.backendSetupPath
    ? await loadBackendSetupModule({
        resolvedSetupPath: input.snapshot.backendSetupPath,
        expectedHash: input.snapshot.backendSetupHash ?? undefined,
      })
    : null;

  return {
    backendExecutionRef: input.backendExecutionRef,
    workflowBaseDir: input.workflowBaseDir ?? null,
    backendStateRoot: ensureBackendStateRoot(input.runRoot, input.backendExecutionRef),
    originalSetupRef: input.originalSetupRef ?? null,
    resolvedSetupPath: input.snapshot.backendSetupPath,
    setupCallback: loadedSetup?.callback ?? null,
    snapshot: {
      cwd: input.snapshot.cwd,
      backendSetupPath: input.snapshot.backendSetupPath,
      backendSetupHash: loadedSetup?.hash ?? input.snapshot.backendSetupHash ?? null,
    },
  };
}

export function createDefaultBackendBootstrap(input: {
  backendExecutionRef: string;
  runRoot: string;
  defaultCwd: string;
  workflowBaseDir?: string | null;
}): ResolvedBackendBootstrap {
  return {
    backendExecutionRef: input.backendExecutionRef,
    workflowBaseDir: input.workflowBaseDir ?? null,
    backendStateRoot: ensureBackendStateRoot(input.runRoot, input.backendExecutionRef),
    originalSetupRef: null,
    resolvedSetupPath: null,
    setupCallback: null,
    snapshot: {
      cwd: input.defaultCwd,
      backendSetupPath: null,
      backendSetupHash: null,
    },
  };
}

function resolveNodeCwd(
  node: GraphNode,
  backendCallContext: BackendCallContext,
  defaultCwd: string,
): string {
  const raw = readStringAttr(node, "cwd");
  if (!raw) {
    return defaultCwd;
  }
  const expression = parseRuntimePathExpression(raw);
  if (!expression) {
    throw new Error(`Node '${node.id}' has invalid cwd runtime path: ${raw}`);
  }
  return resolveRuntimePathExpression(expression, {
    [WORKFLOW_BASE_DIR_TOKEN]: backendCallContext.workflowBaseDir ?? undefined,
    [RUN_ROOT_TOKEN]: backendCallContext.logsRoot,
  });
}

function resolveBackendSetupPath(
  node: GraphNode,
  backendCallContext: BackendCallContext,
): string | null {
  const raw = readStringAttr(node, "backend_setup");
  if (!raw) {
    return null;
  }
  const expression = parseRuntimePathExpression(raw);
  if (!expression) {
    throw new Error(`Node '${node.id}' has invalid backend_setup runtime path: ${raw}`);
  }
  if (expression.token !== WORKFLOW_BASE_DIR_TOKEN) {
    throw new Error(
      `Node '${node.id}' backend_setup must resolve from ${WORKFLOW_BASE_DIR_TOKEN}`,
    );
  }
  if (!backendCallContext.workflowBaseDir) {
    throw new Error(
      `Node '${node.id}' backend_setup requires workflowBaseDir but the backend call context is missing it`,
    );
  }
  return resolveRuntimePathExpression(expression, {
    [WORKFLOW_BASE_DIR_TOKEN]: backendCallContext.workflowBaseDir,
  });
}

async function loadBackendSetupModule(input: {
  resolvedSetupPath: string;
  expectedHash?: string;
}): Promise<{ callback: BackendSetupCallback; hash: string }> {
  const resolvedSetupPath = path.resolve(input.resolvedSetupPath);
  if (!existsSync(resolvedSetupPath)) {
    throw new Error(`backend_setup module not found at ${resolvedSetupPath}`);
  }

  const source = readFileSync(resolvedSetupPath);
  const hash = createHash("sha256").update(source).digest("hex");
  if (input.expectedHash && input.expectedHash !== hash) {
    throw new Error(
      `backend_setup module drift detected at ${resolvedSetupPath}: expected ${input.expectedHash}, got ${hash}`,
    );
  }

  const imported = await import(pathToFileURL(resolvedSetupPath).href);
  if (typeof imported.default !== "function") {
    throw new Error(
      `backend_setup module '${resolvedSetupPath}' must export a default setup callback`,
    );
  }

  return {
    callback: imported.default as BackendSetupCallback,
    hash,
  };
}

function ensureBackendStateRoot(runRoot: string, backendExecutionRef: string): string {
  const backendStateRoot = path.join(
    runRoot,
    ".backend-pi-dev",
    sanitizeBackendExecutionRef(backendExecutionRef),
  );
  mkdirSync(backendStateRoot, { recursive: true });
  return backendStateRoot;
}

function sanitizeBackendExecutionRef(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readStringAttr(node: GraphNode, attr: string): string | null {
  const value = node.attrs[attr];
  return typeof value === "string" && value.length > 0 ? value : null;
}
