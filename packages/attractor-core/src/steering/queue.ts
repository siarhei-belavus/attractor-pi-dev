import type { Context } from "../state/context.js";

export interface SteeringTarget {
  runId: string;
  executionId?: string;
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

export function matchesSteeringTarget(
  messageTarget: SteeringTarget,
  consumerTarget: SteeringTarget,
): boolean {
  if (messageTarget.runId !== consumerTarget.runId) {
    return false;
  }
  if (
    messageTarget.executionId !== undefined &&
    messageTarget.executionId !== consumerTarget.executionId
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

export function getRunScopedSteeringTarget(runId: string): SteeringTarget {
  return { runId };
}

export function getCurrentSteeringTarget(context: Context): SteeringTarget | null {
  const runId = context.getString("internal.run_id");
  if (!runId) {
    return null;
  }

  const target: SteeringTarget = { runId };
  const executionId = context.getString("internal.current_execution_id");
  const branchKey = context.getString("internal.current_branch_key");
  const nodeId = context.getString("internal.current_node_id");

  if (executionId) {
    target.executionId = executionId;
  }
  if (branchKey) {
    target.branchKey = branchKey;
  }
  if (nodeId) {
    target.nodeId = nodeId;
  }
  return target;
}

export function getLastCompletedSteeringTarget(context: Context): SteeringTarget | null {
  const runId = context.getString("internal.run_id");
  if (!runId) {
    return null;
  }

  const target: SteeringTarget = { runId };
  const executionId = context.getString("internal.last_completed_execution_id");
  const branchKey = context.getString("internal.last_completed_branch_key");
  const nodeId = context.getString("internal.last_completed_node_id");

  if (executionId) {
    target.executionId = executionId;
  }
  if (branchKey) {
    target.branchKey = branchKey;
  }
  if (nodeId) {
    target.nodeId = nodeId;
  }
  return target;
}
