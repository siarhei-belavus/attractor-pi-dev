import type { Context } from "../state/context.js";
import { createSteeringTarget, type SteeringTarget } from "../steering/queue.js";

export interface ManagerChildExecution {
  id: string;
  runId: string;
  ownerNodeId: string;
  source: "dotfile" | "attached";
  autostart: boolean;
  dotfile?: string;
  adapterTarget?: {
    executionId?: string;
    branchKey?: string;
    nodeId?: string;
  };
}

const CHILD_ID_KEY = "stack.manager_loop.child.id";
const CHILD_RUN_ID_KEY = "stack.manager_loop.child.run_id";
const CHILD_OWNER_NODE_KEY = "stack.manager_loop.child.owner_node_id";
const CHILD_SOURCE_KEY = "stack.manager_loop.child.source";
const CHILD_AUTOSTART_KEY = "stack.manager_loop.child.autostart";
const CHILD_DOTFILE_KEY = "stack.manager_loop.child.dotfile";
const CHILD_ADAPTER_EXECUTION_KEY = "stack.manager_loop.child.adapter.execution_id";
const CHILD_ADAPTER_BRANCH_KEY = "stack.manager_loop.child.adapter.branch_key";
const CHILD_ADAPTER_NODE_KEY = "stack.manager_loop.child.adapter.node_id";
const INTERNAL_CHILD_ID_KEY = "internal.manager_child_execution_id";

export function createManagerChildExecution(
  input: ManagerChildExecution,
): ManagerChildExecution {
  return {
    id: input.id,
    runId: input.runId,
    ownerNodeId: input.ownerNodeId,
    source: input.source,
    autostart: input.autostart,
    ...(input.dotfile ? { dotfile: input.dotfile } : {}),
    ...(input.adapterTarget ? { adapterTarget: { ...input.adapterTarget } } : {}),
  };
}

export function getManagerChildSteeringTarget(
  context: Context,
): SteeringTarget | null {
  const execution = getManagerChildExecution(context);
  if (!execution) {
    return null;
  }
  return createSteeringTarget(execution.runId, {
    childExecutionId: execution.id,
  });
}

export function applyManagerChildExecution(
  context: Context,
  execution: ManagerChildExecution,
): void {
  context.set(CHILD_ID_KEY, execution.id);
  context.set(CHILD_RUN_ID_KEY, execution.runId);
  context.set(CHILD_OWNER_NODE_KEY, execution.ownerNodeId);
  context.set(CHILD_SOURCE_KEY, execution.source);
  context.set(CHILD_AUTOSTART_KEY, execution.autostart ? "true" : "false");
  context.set(INTERNAL_CHILD_ID_KEY, execution.id);

  if (execution.dotfile) {
    context.set(CHILD_DOTFILE_KEY, execution.dotfile);
  } else {
    context.delete(CHILD_DOTFILE_KEY);
  }

  if (execution.adapterTarget?.executionId) {
    context.set(CHILD_ADAPTER_EXECUTION_KEY, execution.adapterTarget.executionId);
  } else {
    context.delete(CHILD_ADAPTER_EXECUTION_KEY);
  }
  if (execution.adapterTarget?.branchKey) {
    context.set(CHILD_ADAPTER_BRANCH_KEY, execution.adapterTarget.branchKey);
  } else {
    context.delete(CHILD_ADAPTER_BRANCH_KEY);
  }
  if (execution.adapterTarget?.nodeId) {
    context.set(CHILD_ADAPTER_NODE_KEY, execution.adapterTarget.nodeId);
  } else {
    context.delete(CHILD_ADAPTER_NODE_KEY);
  }
}

export function getManagerChildExecution(
  context: Context,
): ManagerChildExecution | null {
  const id = context.getString(CHILD_ID_KEY);
  const runId = context.getString(CHILD_RUN_ID_KEY);
  const ownerNodeId = context.getString(CHILD_OWNER_NODE_KEY);
  const source = context.getString(CHILD_SOURCE_KEY);
  if (!id || !runId || !ownerNodeId || (source !== "dotfile" && source !== "attached")) {
    return null;
  }

  const autostart = context.getString(CHILD_AUTOSTART_KEY) !== "false";
  const dotfile = context.getString(CHILD_DOTFILE_KEY);
  const executionId = context.getString(CHILD_ADAPTER_EXECUTION_KEY);
  const branchKey = context.getString(CHILD_ADAPTER_BRANCH_KEY);
  const nodeId = context.getString(CHILD_ADAPTER_NODE_KEY);

  return createManagerChildExecution({
    id,
    runId,
    ownerNodeId,
    source,
    autostart,
    ...(dotfile ? { dotfile } : {}),
    ...((executionId || branchKey || nodeId)
      ? {
          adapterTarget: {
            ...(executionId ? { executionId } : {}),
            ...(branchKey ? { branchKey } : {}),
            ...(nodeId ? { nodeId } : {}),
          },
        }
      : {}),
  });
}

