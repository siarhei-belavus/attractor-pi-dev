import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type {
  AttachedExecutionSnapshot,
  AttachedExecutionSupervisor,
  AttachedExecutionTarget,
  CapableBackend,
  CodergenBackend,
  DebugEvent,
  DebugSnapshot,
  DebugTelemetrySink,
  GraphNode,
  Context,
  ManagerChildExecution,
  Outcome,
  SteeringQueue,
  SteeringTarget,
} from "@attractor/core";
import {
  StageStatus,
  getCurrentSteeringTarget,
} from "@attractor/core";
import {
  Session,
  SessionState,
  type SessionConfig,
  type SessionEvent,
  type SessionRuntimeSnapshot,
} from "./session.js";
import {
  createAnthropicProfile,
  createOpenAIProfile,
  createGeminiProfile,
  type ProviderProfile,
} from "./provider-profile.js";
import {
  LocalExecutionEnvironment,
  type ExecutionEnvironment,
} from "./execution-env.js";
import {
  type PiResourcePolicy,
  type PiResourcePolicyInput,
  parsePiResourcePolicyFromEnv,
  resolvePiResourcePolicy,
} from "./extension-resource-policy.js";

export interface PiSessionObserverSnapshot {
  childStatus: "running" | "completed" | "failed";
  childOutcome?: "success" | "fail";
  childLockDecision?: "resolved" | "reopen";
  telemetry: {
    session_state: SessionState;
    awaiting_input: boolean;
    last_assistant_text: string;
    message_count: number;
    active_tools: string[];
    tool_policy_diagnostics: string[];
    thread_key: string;
    provider: string;
    model_id: string;
    turn_count: number;
    tool_round_count: number;
    last_activity_at: number | null;
    failure_reason?: string;
  };
}

export interface PiAgentBackendOptions {
  /** Default model provider (e.g. "anthropic", "openai", "google") */
  defaultProvider?: string;
  /** Default model ID (e.g. "claude-sonnet-4-5-20250929") */
  defaultModel?: string;
  /** Default thinking level */
  defaultThinkingLevel?: ThinkingLevel;
  /** Working directory for coding tools */
  cwd?: string;
  /** Event listener for session events */
  debugSink?: DebugTelemetrySink;
  /** Legacy event listener for raw agent events */
  onAgentEvent?: (event: AgentSessionEvent) => void;
  /** Reuse sessions across nodes sharing a thread_id */
  reuseSessions?: boolean;
  /** Session configuration overrides */
  sessionConfig?: Partial<SessionConfig>;
  /** Custom execution environment (default: local) */
  executionEnv?: ExecutionEnvironment;
  /** Custom provider profile factory override */
  createProfile?: (provider: string, cwd: string) => ProviderProfile;
  /** Explicit runtime resource policy (takes precedence over env vars) */
  resourcePolicy?: PiResourcePolicyInput;
  /** Warning listener */
  onWarning?: (message: string) => void;
  /** Shared steering queue used by manager/API/CLI producers and backend consumers */
  steeringQueue?: SteeringQueue;
}

/**
 * CodergenBackend implementation using pi-mono's coding agent,
 * wrapped with spec-compliant Session (state machine, limits, loop detection).
 *
 * Each node execution creates (or reuses) a Session with provider-specific
 * tools, sends the prompt, waits for completion, and returns the response.
 */
export class PiAgentCodergenBackend
  implements CapableBackend, AttachedExecutionSupervisor
{
  private options: Required<
    Pick<
      PiAgentBackendOptions,
      "defaultProvider" | "defaultModel" | "defaultThinkingLevel" | "cwd" | "reuseSessions"
    >
  > & PiAgentBackendOptions;
  private sessions = new Map<string, Session>();
  private sessionMetadata = new Map<string, { provider: string; modelId: string }>();
  private childExecutionBindings = new Map<string, SteeringTarget>();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private executionEnv?: ExecutionEnvironment;
  private resourcePolicy: PiResourcePolicy;

  constructor(opts?: PiAgentBackendOptions) {
    this.options = {
      defaultProvider: opts?.defaultProvider ?? "anthropic",
      defaultModel: opts?.defaultModel ?? "claude-sonnet-4-5-20250929",
      defaultThinkingLevel: opts?.defaultThinkingLevel ?? "high",
      cwd: opts?.cwd ?? process.cwd(),
      reuseSessions: opts?.reuseSessions ?? true,
      ...opts,
    };
    this.authStorage = new AuthStorage();
    this.modelRegistry = new ModelRegistry(this.authStorage);
    this.executionEnv = opts?.executionEnv;
    const envPolicy = parsePiResourcePolicyFromEnv(process.env, this.warn.bind(this));
    this.resourcePolicy = resolvePiResourcePolicy(
      opts?.resourcePolicy,
      envPolicy,
      this.warn.bind(this),
    );
  }

  async run(
    node: GraphNode,
    prompt: string,
    context: Context,
  ): Promise<string | Outcome> {
    const provider = node.llmProvider || this.options.defaultProvider;
    const modelId = node.llmModel || this.options.defaultModel;
    const thinkingLevel = this.resolveThinkingLevel(node);
    const threadKey = this.resolveThreadKey(node, context);
    const cwd = this.options.cwd;

    // Get or create session
    let session: Session;
    if (this.options.reuseSessions && this.sessions.has(threadKey)) {
      session = this.sessions.get(threadKey)!;
      this.sessionMetadata.set(threadKey, { provider, modelId });
      // Update reasoning effort if needed
      session.setReasoningEffort(thinkingLevel);
    } else {
      // Resolve profile
      const profile = this.resolveProfile(provider, modelId, thinkingLevel, cwd);

      // Create execution environment if not provided
      const execEnv = this.executionEnv ?? new LocalExecutionEnvironment({ cwd });

      session = new Session({
        profile,
        executionEnv: execEnv,
        config: this.options.sessionConfig,
        resourcePolicy: this.resourcePolicy,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        onWarning: this.warn.bind(this),
      });

      // Wire up event listeners
      if (this.options.debugSink) {
        session.subscribe((event) => {
          this.options.debugSink?.writeEvent(this.mapDebugEvent(threadKey, event));
        });
      }

      if (this.options.reuseSessions) {
        this.sessions.set(threadKey, session);
        this.sessionMetadata.set(threadKey, { provider, modelId });
      }
    }

    try {
      await session.initialize();
      context.set("internal.current_backend_execution_ref", threadKey);
    } catch (err) {
      this.emitDebugSnapshot(
        "before_submit",
        session,
        threadKey,
        provider,
        modelId,
        context.getString("internal.current_node_id") || undefined,
      );
      return {
        status: StageStatus.FAIL,
        failureReason: `Agent initialization failed: ${err}`,
      };
    }

    const currentTarget = this.resolveConsumerTarget(context);
    this.bindManagerChildExecution(currentTarget);
    this.deliverSteeringMessages(currentTarget, session);
    this.emitDebugSnapshot(
      "before_submit",
      session,
      threadKey,
      provider,
      modelId,
      context.getString("internal.current_node_id") || undefined,
    );

    // Send prompt and wait for completion
    try {
      await session.submit(prompt);
    } catch (err) {
      context.set("internal.last_completed_backend_execution_ref", threadKey);
      return {
        status: StageStatus.FAIL,
        failureReason: `Agent execution failed: ${err}`,
      };
    }

    context.set("internal.last_completed_backend_execution_ref", threadKey);
    this.emitDebugSnapshot(
      "after_submit",
      session,
      threadKey,
      provider,
      modelId,
      context.getString("internal.current_node_id") || undefined,
    );

    // Extract the assistant's text response
    const responseText = session.getLastAssistantText() ?? "";

    if (!responseText) {
      return {
        status: StageStatus.FAIL,
        failureReason: "Agent returned empty response",
      };
    }

    return responseText;
  }

  /** Resolve a ProviderProfile from provider name */
  private resolveProfile(
    provider: string,
    modelId: string,
    thinkingLevel: ThinkingLevel,
    cwd: string,
  ): ProviderProfile {
    if (this.options.createProfile) {
      return this.options.createProfile(provider, cwd);
    }

    const execEnv = this.executionEnv;
    const profileOpts = {
      provider,
      modelId,
      thinkingLevel,
      cwd,
      executionEnv: execEnv,
    };

    switch (provider) {
      case "openai":
      case "azure-openai-responses":
      case "openai-codex":
        return createOpenAIProfile(profileOpts);
      case "google":
      case "google-gemini-cli":
      case "google-vertex":
        return createGeminiProfile(profileOpts);
      default:
        // Anthropic is the default for all other providers
        return createAnthropicProfile(profileOpts);
    }
  }

  /** Map reasoning_effort to pi-mono ThinkingLevel */
  private resolveThinkingLevel(node: GraphNode): ThinkingLevel {
    switch (node.reasoningEffort) {
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      default:
        return this.options.defaultThinkingLevel;
    }
  }

  /** Determine session reuse key from node/context */
  private resolveThreadKey(node: GraphNode, context: Context): string {
    const effectiveFidelity = context.getString("internal.effective_fidelity");
    const resolvedThreadKey = context.getString("internal.thread_key");
    if (effectiveFidelity === "full" && resolvedThreadKey) return resolvedThreadKey;
    // 1. Explicit thread_id on node
    if (node.threadId) return node.threadId;
    // 2. Derived from class (subgraph)
    if (node.classes.length > 0) return node.classes[0]!;
    // 3. Fallback to node ID
    return node.id;
  }

  /** Clean up all sessions */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.dispose();
    }
    this.sessions.clear();
    this.sessionMetadata.clear();
  }

  getCapabilities() {
    return {
      debugTelemetry: true,
      attachedExecutionSupervision: true,
    };
  }

  asAttachedExecutionSupervisor(): AttachedExecutionSupervisor {
    return this;
  }

  getObserverSnapshot(bindingKey: string): PiSessionObserverSnapshot | null {
    const session = this.sessions.get(bindingKey);
    if (!session) {
      return null;
    }

    const runtime = session.getRuntimeSnapshot();
    const metadata = this.sessionMetadata.get(bindingKey) ?? {
      provider: this.options.defaultProvider,
      modelId: this.options.defaultModel,
    };
    const childStatus = this.mapChildStatus(runtime);
    const childOutcome = runtime.terminalOutcome ?? undefined;
    const childLockDecision =
      childOutcome === "success"
        ? "resolved"
        : childOutcome === "fail"
          ? "reopen"
          : undefined;

    return {
      childStatus,
      ...(childOutcome ? { childOutcome } : {}),
      ...(childLockDecision ? { childLockDecision } : {}),
      telemetry: {
        session_state: runtime.state,
        awaiting_input: runtime.awaitingInput,
        last_assistant_text: runtime.lastAssistantText,
        message_count: runtime.messageCount,
        active_tools: runtime.activeTools,
        tool_policy_diagnostics: runtime.toolPolicyDiagnostics,
        thread_key: bindingKey,
        provider: metadata.provider,
        model_id: metadata.modelId,
        turn_count: runtime.turnCount,
        tool_round_count: runtime.toolRoundCount,
        last_activity_at: runtime.lastActivityAt,
        ...(runtime.failureReason ? { failure_reason: runtime.failureReason } : {}),
      },
    };
  }

  private mapChildStatus(runtime: SessionRuntimeSnapshot): "running" | "completed" | "failed" {
    if (runtime.state === SessionState.PROCESSING) {
      return "running";
    }
    if (runtime.state === SessionState.AWAITING_INPUT) {
      return "running";
    }
    if (runtime.terminalOutcome === "success") {
      return "completed";
    }
    if (runtime.terminalOutcome === "fail") {
      return "failed";
    }
    return "running";
  }

  private warn(message: string): void {
    if (this.options.onWarning) {
      this.options.onWarning(message);
      return;
    }
    console.warn(`[backend-pi-dev] ${message}`);
  }

  private emitDebugSnapshot(
    phase: "before_submit" | "after_submit",
    session: Session,
    threadKey: string,
    provider: string,
    modelId: string,
    nodeId?: string,
  ): void {
    this.options.debugSink?.writeSnapshot({
      phase,
      sessionKey: threadKey,
      ...(nodeId ? { nodeId } : {}),
      provider,
      modelId,
      activeTools: session.getActiveToolNames(),
      promptText: session.getSystemPrompt() ?? "",
      diagnostics: session.getToolPolicyDiagnostics(),
    });
  }

  private mapDebugEvent(threadKey: string, event: SessionEvent): DebugEvent {
    return {
      kind: event.kind,
      timestamp: event.timestamp,
      data: {
        sessionKey: threadKey,
        ...event.data,
      },
    };
  }

  consumeQueuedSteering(target: SteeringTarget | null, sessionOverride?: { steer: (message: string) => void }): string[] {
    return this.deliverSteeringMessages(target, sessionOverride);
  }

  private deliverSteeringMessages(
    target: SteeringTarget | null,
    sessionOverride?: { steer: (message: string) => void },
  ): string[] {
    if (!target || !this.options.steeringQueue) {
      return [];
    }

    const boundTarget = this.resolveBoundTarget(target);
    const session = sessionOverride ?? (
      boundTarget?.backendExecutionRef
        ? this.sessions.get(boundTarget.backendExecutionRef)
        : undefined
    );
    if (!session) {
      return [];
    }

    const messages = this.options.steeringQueue.drain(target);
    for (const message of messages) {
      session.steer(message.message);
    }
    return messages.map((message) => message.message);
  }

  private resolveConsumerTarget(context: Context): SteeringTarget | null {
    return getCurrentSteeringTarget(context);
  }

  private bindManagerChildExecution(target: SteeringTarget | null): void {
    if (!target?.childExecutionId) {
      return;
    }
    this.childExecutionBindings.set(
      this.getChildExecutionBindingKey(target.runId, target.childExecutionId),
      target,
    );
  }

  private resolveBoundTarget(target: SteeringTarget): SteeringTarget | null {
    if (target.childExecutionId) {
      const bound = this.childExecutionBindings.get(
        this.getChildExecutionBindingKey(target.runId, target.childExecutionId),
      );
      if (bound) {
        return {
          ...bound,
          ...target,
        };
      }
    }
    return target;
  }

  resolveChildExecutionSessionId(childExecution: ManagerChildExecution): string {
    if (childExecution.kind === "attached_backend_execution") {
      return childExecution.attachedTarget.backendExecutionRef;
    }
    const bound = this.resolveBoundTarget({
      runId: childExecution.runId,
      childExecutionId: childExecution.id,
    });
    return bound?.backendExecutionRef ?? "";
  }

  private getChildExecutionBindingKey(runId: string, childExecutionId: string): string {
    return `${runId}::${childExecutionId}`;
  }

  async observeAttachedExecution(
    target: AttachedExecutionTarget,
    context: Context,
  ): Promise<AttachedExecutionSnapshot> {
    const managerTarget = this.resolveConsumerTarget(context);
    const steeringTarget: SteeringTarget | null = managerTarget
      ? {
          ...managerTarget,
          backendExecutionRef: target.backendExecutionRef,
          ...(target.branchKey ? { branchKey: target.branchKey } : {}),
          ...(target.nodeId ? { nodeId: target.nodeId } : {}),
        }
      : null;
    this.consumeQueuedSteering(steeringTarget);

    const snapshot = this.getObserverSnapshot(target.backendExecutionRef);
    if (!snapshot) {
      throw new Error(
        `Manager loop child session '${target.backendExecutionRef}' is unavailable`,
      );
    }
    return {
      status: snapshot.childStatus,
      ...(snapshot.childOutcome ? { outcome: snapshot.childOutcome } : {}),
      ...(snapshot.childLockDecision ? { lockDecision: snapshot.childLockDecision } : {}),
      telemetry: snapshot.telemetry,
    };
  }

  async steerAttachedExecution(
    target: AttachedExecutionTarget,
    message: string,
    _context: Context,
  ): Promise<void> {
    const session = this.sessions.get(target.backendExecutionRef);
    if (!session) {
      throw new Error(`Attached execution '${target.backendExecutionRef}' is unavailable`);
    }
    session.steer(message);
  }
}
