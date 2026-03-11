import type { Context } from "../state/context.js";

export interface SteeringTarget {
  runId: string;
  childExecutionId?: string;
  backendExecutionRef?: string;
  branchKey?: string;
  nodeId?: string;
}

export type SteeringSource = "manager" | "cli" | "api" | "system";

export interface SteeringMessage {
  id: string;
  target: SteeringTarget;
  message: string;
  source: SteeringSource;
  createdAt: string;
}

export interface SteeringQueue {
  enqueue(message: SteeringMessage): void;
  drain(target: SteeringTarget): SteeringMessage[];
  peek(target: SteeringTarget): SteeringMessage[];
}

let nextSteeringMessageId = 1;

export function createSteeringMessage(input: Omit<SteeringMessage, "id" | "createdAt">): SteeringMessage {
  return {
    id: `steer-${nextSteeringMessageId++}`,
    createdAt: new Date().toISOString(),
    ...input,
  };
}

export class InMemorySteeringQueue implements SteeringQueue {
  private readonly messages: SteeringMessage[] = [];

  enqueue(message: SteeringMessage): void {
    this.messages.push(message);
  }

  drain(target: SteeringTarget): SteeringMessage[] {
    const kept: SteeringMessage[] = [];
    const drained: SteeringMessage[] = [];

    for (const message of this.messages) {
      if (matchesSteeringTarget(message.target, target)) {
        drained.push(message);
      } else {
        kept.push(message);
      }
    }

    this.messages.splice(0, this.messages.length, ...kept);
    return drained;
  }

  peek(target: SteeringTarget): SteeringMessage[] {
    return this.messages.filter((message) => matchesSteeringTarget(message.target, target));
  }
}

/**
 * Steering target matching is intentionally exact for every field present on the message:
 * - `runId` is always required and always matched exactly.
 * - If a message includes `childExecutionId`, the consumer must present the same value.
 * - If a message includes `backendExecutionRef`, `branchKey`, or `nodeId`, the consumer must
 *   present the same value for that field to drain it.
 * - If a field is absent on the message, it does not participate in matching.
 *
 * This means "broadcast" is only possible when a producer deliberately omits narrower fields.
 * In this first pass, producers are expected to target specific executions rather than rely on
 * implicit run-wide broadcast. `nodeId` participates so a message aimed at one execution stage
 * does not get consumed by a different stage reusing the same execution scope.
 */
export function matchesSteeringTarget(
  messageTarget: SteeringTarget,
  consumerTarget: SteeringTarget,
): boolean {
  if (messageTarget.runId !== consumerTarget.runId) {
    return false;
  }
  if (
    messageTarget.childExecutionId !== undefined &&
    messageTarget.childExecutionId !== consumerTarget.childExecutionId
  ) {
    return false;
  }
  if (
    messageTarget.backendExecutionRef !== undefined &&
    messageTarget.backendExecutionRef !== consumerTarget.backendExecutionRef
  ) {
    return false;
  }
  if (
    messageTarget.branchKey !== undefined &&
    messageTarget.branchKey !== consumerTarget.branchKey
  ) {
    return false;
  }
  if (messageTarget.nodeId !== undefined && messageTarget.nodeId !== consumerTarget.nodeId) {
    return false;
  }
  return true;
}

export function createSteeringTarget(
  runId: string,
  opts: {
    childExecutionId?: string;
    backendExecutionRef?: string;
    branchKey?: string;
    nodeId?: string;
  } = {},
): SteeringTarget {
  return {
    runId,
    ...(opts.childExecutionId ? { childExecutionId: opts.childExecutionId } : {}),
    ...(opts.backendExecutionRef ? { backendExecutionRef: opts.backendExecutionRef } : {}),
    ...(opts.branchKey ? { branchKey: opts.branchKey } : {}),
    ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
  };
}

export function getRunScopedSteeringTarget(runId: string): SteeringTarget {
  return createSteeringTarget(runId);
}

export function getCurrentSteeringTarget(context: Context): SteeringTarget | null {
  const runId = context.getString("internal.run_id");
  if (!runId) {
    return null;
  }

  const backendExecutionRef = context.getString("internal.current_backend_execution_ref");
  const childExecutionId = context.getString("internal.manager_child_execution_id");
  const branchKey = context.getString("internal.current_branch_key");
  const nodeId = context.getString("internal.current_node_id");
  return createSteeringTarget(runId, {
    childExecutionId,
    backendExecutionRef,
    branchKey,
    nodeId,
  });
}

export function getLastCompletedSteeringTarget(context: Context): SteeringTarget | null {
  const runId = context.getString("internal.run_id");
  if (!runId) {
    return null;
  }

  const backendExecutionRef = context.getString("internal.last_completed_backend_execution_ref");
  const childExecutionId = context.getString("internal.manager_child_execution_id");
  const branchKey = context.getString("internal.last_completed_branch_key");
  const nodeId = context.getString("internal.last_completed_node_id");
  return createSteeringTarget(runId, {
    childExecutionId,
    backendExecutionRef,
    branchKey,
    nodeId,
  });
}
