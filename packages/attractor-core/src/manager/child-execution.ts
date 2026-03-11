import type { AttachedExecutionTarget } from "../backend/contracts.js";
import type { Context } from "../state/context.js";
import { createSteeringTarget, type SteeringTarget } from "../steering/queue.js";

/**
 * Manager-loop child execution is intentionally explicit:
 * - `managed_pipeline` is a core-owned child pipeline started from a DOT file.
 * - `attached_backend_execution` is a backend-owned live execution target.
 *
 * This discriminated union prevents mixed states such as a managed pipeline with
 * backend-only handles or an attached execution with an autostartable DOT file.
 */
export type ManagerChildExecution =
  | {
      id: string;
      runId: string;
      ownerNodeId: string;
      kind: "managed_pipeline";
      autostart: boolean;
      dotfile: string;
    }
  | {
      id: string;
      runId: string;
      ownerNodeId: string;
      kind: "attached_backend_execution";
      autostart: false;
      attachedTarget: AttachedExecutionTarget;
    };

const CHILD_ID_KEY = "stack.manager_loop.child.id";
const CHILD_RUN_ID_KEY = "stack.manager_loop.child.run_id";
const CHILD_OWNER_NODE_KEY = "stack.manager_loop.child.owner_node_id";
const CHILD_KIND_KEY = "stack.manager_loop.child.kind";
const CHILD_AUTOSTART_KEY = "stack.manager_loop.child.autostart";
const CHILD_DOTFILE_KEY = "stack.manager_loop.child.dotfile";
const CHILD_ATTACHED_EXECUTION_REF_KEY = "stack.manager_loop.child.attached.backend_execution_ref";
const CHILD_ATTACHED_BRANCH_KEY = "stack.manager_loop.child.attached.branch_key";
const CHILD_ATTACHED_NODE_KEY = "stack.manager_loop.child.attached.node_id";
const INTERNAL_CHILD_ID_KEY = "internal.manager_child_execution_id";

export function createManagerChildExecution(
  input: ManagerChildExecution,
): ManagerChildExecution {
  if (input.kind === "managed_pipeline") {
    return {
      id: input.id,
      runId: input.runId,
      ownerNodeId: input.ownerNodeId,
      kind: input.kind,
      autostart: input.autostart,
      dotfile: input.dotfile,
    };
  }

  return {
    id: input.id,
    runId: input.runId,
    ownerNodeId: input.ownerNodeId,
    kind: input.kind,
    autostart: false,
    attachedTarget: { ...input.attachedTarget },
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
  context.set(CHILD_KIND_KEY, execution.kind);
  context.set(CHILD_AUTOSTART_KEY, execution.autostart ? "true" : "false");
  context.set(INTERNAL_CHILD_ID_KEY, execution.id);

  if (execution.kind === "managed_pipeline") {
    context.set(CHILD_DOTFILE_KEY, execution.dotfile);
  } else {
    context.delete(CHILD_DOTFILE_KEY);
  }

  if (execution.kind === "attached_backend_execution") {
    context.set(
      CHILD_ATTACHED_EXECUTION_REF_KEY,
      execution.attachedTarget.backendExecutionRef,
    );
  } else {
    context.delete(CHILD_ATTACHED_EXECUTION_REF_KEY);
  }
  if (execution.kind === "attached_backend_execution" && execution.attachedTarget.branchKey) {
    context.set(CHILD_ATTACHED_BRANCH_KEY, execution.attachedTarget.branchKey);
  } else {
    context.delete(CHILD_ATTACHED_BRANCH_KEY);
  }
  if (execution.kind === "attached_backend_execution" && execution.attachedTarget.nodeId) {
    context.set(CHILD_ATTACHED_NODE_KEY, execution.attachedTarget.nodeId);
  } else {
    context.delete(CHILD_ATTACHED_NODE_KEY);
  }
}

export function getManagerChildExecution(
  context: Context,
): ManagerChildExecution | null {
  const id = context.getString(CHILD_ID_KEY);
  const runId = context.getString(CHILD_RUN_ID_KEY);
  const ownerNodeId = context.getString(CHILD_OWNER_NODE_KEY);
  const kind = context.getString(CHILD_KIND_KEY);
  if (
    !id ||
    !runId ||
    !ownerNodeId ||
    (kind !== "managed_pipeline" && kind !== "attached_backend_execution")
  ) {
    return null;
  }

  const autostart = context.getString(CHILD_AUTOSTART_KEY) !== "false";
  const dotfile = context.getString(CHILD_DOTFILE_KEY);
  const backendExecutionRef = context.getString(CHILD_ATTACHED_EXECUTION_REF_KEY);
  const branchKey = context.getString(CHILD_ATTACHED_BRANCH_KEY);
  const nodeId = context.getString(CHILD_ATTACHED_NODE_KEY);

  if (kind === "managed_pipeline") {
    if (!dotfile) {
      return null;
    }
    return createManagerChildExecution({
      id,
      runId,
      ownerNodeId,
      kind,
      autostart,
      dotfile,
    });
  }

  if (!backendExecutionRef) {
    return null;
  }
  return createManagerChildExecution({
    id,
    runId,
    ownerNodeId,
    kind,
    autostart: false,
    attachedTarget: {
      backendExecutionRef,
      ...(branchKey ? { branchKey } : {}),
      ...(nodeId ? { nodeId } : {}),
    },
  });
}
