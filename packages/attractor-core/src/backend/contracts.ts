import type { Context } from "../state/context.js";
import type { CodergenBackend } from "../handlers/types.js";
import type { SteeringQueue } from "../steering/queue.js";

export interface AttachedExecutionTarget {
  backendExecutionRef: string;
  branchKey?: string;
  nodeId?: string;
}

export interface AttachedExecutionSnapshot {
  status: "running" | "completed" | "failed";
  outcome?: string;
  lockDecision?: "resolved" | "reopen";
  telemetry?: Record<string, unknown>;
}

export interface AttachedExecutionSupervisor {
  observeAttachedExecution(
    target: AttachedExecutionTarget,
    context: Context,
  ): Promise<AttachedExecutionSnapshot>;

  steerAttachedExecution(
    target: AttachedExecutionTarget,
    message: string,
    context: Context,
  ): Promise<void>;
}

export interface BackendFactoryOptions {
  cwd: string;
  provider?: string;
  model?: string;
  steeringQueue?: SteeringQueue;
  debugSink?: DebugTelemetrySink;
  warningSink?: (message: string) => void;
}

export interface BackendCapabilities {
  debugTelemetry?: boolean;
  attachedExecutionSupervision?: boolean;
}

export interface DebugSnapshot {
  phase: "before_submit" | "after_submit";
  sessionKey: string;
  nodeId?: string;
  promptText?: string;
  activeTools?: string[];
  diagnostics?: string[];
  provider?: string;
  modelId?: string;
}

export interface DebugEvent {
  kind: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface DebugTelemetrySink {
  writeEvent(event: DebugEvent): void;
  writeSnapshot(snapshot: DebugSnapshot): void;
}

export interface CapableBackend extends CodergenBackend {
  getCapabilities?(): BackendCapabilities;
  asAttachedExecutionSupervisor?(): AttachedExecutionSupervisor | null;
}
