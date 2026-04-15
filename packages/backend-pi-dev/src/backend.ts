import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  type AgentSessionEvent,
  type SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AttachedExecutionSnapshot,
  AttachedExecutionSupervisor,
  AttachedExecutionTarget,
  BackendCallContext,
  BackendSessionAccessMode,
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
  BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY,
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
import {
  PersistentSessionStore,
  type PersistentSessionResolutionMode,
} from "./persistent-session-store.js";

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
    backend_execution_ref: string;
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

interface PiAgentSettingsDefaults {
  defaultProvider?: string;
  defaultModel?: string;
}

function resolvePiAgentDir(): string {
  const envDir = process.env["PI_CODING_AGENT_DIR"];
  if (!envDir) {
    return join(homedir(), ".pi", "agent");
  }
  if (envDir === "~") {
    return homedir();
  }
  if (envDir.startsWith("~/")) {
    return join(homedir(), envDir.slice(2));
  }
  return envDir;
}

function loadPiAgentSettingsDefaults(): PiAgentSettingsDefaults {
  const settingsPath = join(resolvePiAgentDir(), "settings.json");
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    return {
      ...(typeof raw["defaultProvider"] === "string"
        ? { defaultProvider: raw["defaultProvider"] }
        : {}),
      ...(typeof raw["defaultModel"] === "string" ? { defaultModel: raw["defaultModel"] } : {}),
    };
  } catch {
    return {};
  }
}

const CANONICAL_PERSISTENCE_MARKER_VALUE = "pi_manifest_v1";

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
  private persistentSessionStore = new PersistentSessionStore();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private executionEnv?: ExecutionEnvironment;
  private resourcePolicy: PiResourcePolicy;

  constructor(opts?: PiAgentBackendOptions) {
    const piDefaults = loadPiAgentSettingsDefaults();
    this.options = {
      defaultProvider: opts?.defaultProvider ?? piDefaults.defaultProvider ?? "anthropic",
      defaultModel: opts?.defaultModel ?? piDefaults.defaultModel ?? "claude-sonnet-4-5-20250929",
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
    backendCallContext: BackendCallContext,
  ): Promise<string | Outcome> {
    const provider = node.llmProvider || this.options.defaultProvider;
    const modelId = node.llmModel || this.options.defaultModel;
    const thinkingLevel = this.resolveThinkingLevel(node);
    const backendExecutionRef = this.resolveBackendExecutionRef(node);
    const cacheKey = this.getRunScopedSessionKey(
      backendCallContext.runId,
      backendExecutionRef,
    );

    let session: Session;
    try {
      session = await this.ensureRunSession({
        backendCallContext,
        context,
        backendExecutionRef,
        cacheKey,
        provider,
        modelId,
        thinkingLevel,
      });
      context.set("internal.current_backend_execution_ref", backendExecutionRef);
      context.set(BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY, CANONICAL_PERSISTENCE_MARKER_VALUE);
    } catch (err) {
      return {
        status: StageStatus.FAIL,
        failureReason: `Persistent session setup failed: ${err}`,
      };
    }

    const currentTarget = this.resolveConsumerTarget(context);
    this.bindManagerChildExecution(currentTarget);
    this.deliverSteeringMessages(currentTarget, session);
    this.emitDebugSnapshot(
      "before_submit",
      session,
      cacheKey,
      provider,
      modelId,
      context.getString("internal.current_node_id") || undefined,
    );

    try {
      await session.submit(prompt);
    } catch (err) {
      context.set("internal.last_completed_backend_execution_ref", backendExecutionRef);
      context.set(BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY, CANONICAL_PERSISTENCE_MARKER_VALUE);
      return {
        status: StageStatus.FAIL,
        failureReason: `Agent execution failed: ${err}`,
      };
    }

    context.set("internal.last_completed_backend_execution_ref", backendExecutionRef);
    context.set(BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY, CANONICAL_PERSISTENCE_MARKER_VALUE);
    this.emitDebugSnapshot(
      "after_submit",
      session,
      cacheKey,
      provider,
      modelId,
      context.getString("internal.current_node_id") || undefined,
    );

    const runtime = session.getRuntimeSnapshot();
    if (runtime.terminalOutcome === "fail") {
      return {
        status: StageStatus.FAIL,
        failureReason: runtime.failureReason || "Agent execution failed",
      };
    }

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

  private resolveBackendExecutionRef(node: GraphNode): string {
    return node.threadId || node.id;
  }

  private getRunScopedSessionKey(runId: string, backendExecutionRef: string): string {
    return `${runId}::${backendExecutionRef}`;
  }

  private isCanonicalCheckpoint(context: Context): boolean {
    return (
      context.getString(BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY) ===
      CANONICAL_PERSISTENCE_MARKER_VALUE
    );
  }

  private assertCachedSessionConsistency(
    cacheKey: string,
    provider: string,
    modelId: string,
  ): void {
    const metadata = this.sessionMetadata.get(cacheKey);
    if (!metadata) {
      return;
    }
    if (metadata.provider !== provider) {
      throw new Error(
        `Persistent session '${cacheKey}' is locked to provider '${metadata.provider}', not '${provider}'`,
      );
    }
    if (metadata.modelId !== modelId) {
      throw new Error(
        `Persistent session '${cacheKey}' is locked to model '${metadata.modelId}', not '${modelId}'`,
      );
    }
  }

  private resolveRunSessionMode(
    context: Context,
    backendExecutionRef: string,
    sessionAccessMode: BackendSessionAccessMode,
  ): PersistentSessionResolutionMode {
    if (sessionAccessMode === "fresh") {
      return "open_or_create";
    }

    if (!this.isCanonicalCheckpoint(context)) {
      if (sessionAccessMode === "resume_strict") {
        throw new Error(
          "Checkpoint predates persistent Pi sessions; rerun with force to recreate canonical session state",
        );
      }
      return "recreate";
    }

    if (sessionAccessMode === "resume_force") {
      return "recreate";
    }

    const lastCompletedBackendExecutionRef = context.getString(
      "internal.last_completed_backend_execution_ref",
    );
    if (lastCompletedBackendExecutionRef === backendExecutionRef) {
      return "open_required";
    }
    return "open_or_create";
  }

  private resolveAttachedSessionMode(
    context: Context,
    sessionAccessMode: BackendSessionAccessMode,
  ): PersistentSessionResolutionMode {
    if (sessionAccessMode === "fresh") {
      return "open_required";
    }

    if (!this.isCanonicalCheckpoint(context)) {
      if (sessionAccessMode === "resume_strict") {
        throw new Error(
          "Checkpoint predates persistent Pi sessions; rerun with force to recreate canonical session state",
        );
      }
      return "recreate";
    }

    return sessionAccessMode === "resume_force" ? "recreate" : "open_required";
  }

  private resolveQueuedSessionAccessMode(
    target: SteeringTarget | null,
    fallback: BackendSessionAccessMode,
  ): BackendSessionAccessMode {
    if (!target || !this.options.steeringQueue) {
      return fallback;
    }

    const queued = this.options.steeringQueue.peek(target);
    if (queued.some((message) => message.sessionAccessMode === "resume_force")) {
      return "resume_force";
    }
    if (
      fallback === "fresh" &&
      queued.some((message) => message.sessionAccessMode === "resume_strict")
    ) {
      return "resume_strict";
    }
    return fallback;
  }

  private createSession(
    cacheKey: string,
    profile: ProviderProfile,
    sessionManager: SessionManager,
    onInitialized: (sessionManager: SessionManager) => Promise<void>,
  ): Session {
    const execEnv = this.executionEnv ?? new LocalExecutionEnvironment({ cwd: this.options.cwd });
    const session = new Session({
      profile,
      executionEnv: execEnv,
      config: this.options.sessionConfig,
      resourcePolicy: this.resourcePolicy,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      onWarning: this.warn.bind(this),
      sessionManager,
      onInitialized,
    });

    if (this.options.debugSink) {
      session.subscribe((event) => {
        this.options.debugSink?.writeEvent(this.mapDebugEvent(cacheKey, event));
      });
    }

    return session;
  }

  private async createPersistentSession(args: {
    cacheKey: string;
    backendCallContext: BackendCallContext;
    backendExecutionRef: string;
    provider?: string;
    modelId?: string;
    thinkingLevel: ThinkingLevel;
    mode: PersistentSessionResolutionMode;
  }): Promise<Session> {
    const access = this.persistentSessionStore.resolve({
      sessionRoot: args.backendCallContext.sessionRoot,
      backendExecutionRef: args.backendExecutionRef,
      cwd: this.options.cwd,
      mode: args.mode,
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.modelId ? { model: args.modelId } : {}),
    });
    const profile = this.resolveProfile(
      access.manifest.provider,
      access.manifest.model,
      args.thinkingLevel,
      this.options.cwd,
    );
    const session = this.createSession(
      args.cacheKey,
      profile,
      access.sessionManager,
      async (sessionManager) => {
        const manifest = this.persistentSessionStore.commitAccess({
          ...access,
          sessionManager,
        });
        this.sessionMetadata.set(args.cacheKey, {
          provider: manifest.provider,
          modelId: manifest.model,
        });
      },
    );
    try {
      await session.initialize();
    } catch (error) {
      this.emitDebugSnapshot(
        "before_submit",
        session,
        args.cacheKey,
        access.manifest.provider,
        access.manifest.model,
      );
      throw error;
    }
    this.sessions.set(args.cacheKey, session);
    this.sessionMetadata.set(args.cacheKey, {
      provider: access.manifest.provider,
      modelId: access.manifest.model,
    });
    return session;
  }

  private async ensureRunSession(args: {
    backendCallContext: BackendCallContext;
    context: Context;
    backendExecutionRef: string;
    cacheKey: string;
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
  }): Promise<Session> {
    const mode = this.resolveRunSessionMode(
      args.context,
      args.backendExecutionRef,
      args.backendCallContext.sessionAccessMode,
    );
    const cached = this.sessions.get(args.cacheKey);
    if (cached && mode !== "recreate") {
      this.assertCachedSessionConsistency(args.cacheKey, args.provider, args.modelId);
      cached.setReasoningEffort(args.thinkingLevel);
      return cached;
    }
    if (cached) {
      await this.disposeCachedSession(args.cacheKey);
    }

    return this.createPersistentSession({
      cacheKey: args.cacheKey,
      backendCallContext: args.backendCallContext,
      backendExecutionRef: args.backendExecutionRef,
      provider: args.provider,
      modelId: args.modelId,
      thinkingLevel: args.thinkingLevel,
      mode,
    });
  }

  private async ensureAttachedSession(
    target: AttachedExecutionTarget,
    context: Context,
    backendCallContext: BackendCallContext,
  ): Promise<{ cacheKey: string; session: Session }> {
    const cacheKey = this.getRunScopedSessionKey(
      backendCallContext.runId,
      target.backendExecutionRef,
    );
    const effectiveAccessMode = this.resolveQueuedSessionAccessMode(
      {
        runId: backendCallContext.runId,
        backendExecutionRef: target.backendExecutionRef,
        ...(target.branchKey ? { branchKey: target.branchKey } : {}),
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
      },
      backendCallContext.sessionAccessMode,
    );
    const mode = this.resolveAttachedSessionMode(context, effectiveAccessMode);
    const cached = this.sessions.get(cacheKey);
    if (cached && mode !== "recreate") {
      return { cacheKey, session: cached };
    }
    if (cached) {
      await this.disposeCachedSession(cacheKey);
    }

    const metadata = this.sessionMetadata.get(cacheKey);
    try {
      const session = await this.createPersistentSession({
        cacheKey,
        backendCallContext,
        backendExecutionRef: target.backendExecutionRef,
        ...(metadata?.provider ? { provider: metadata.provider } : {}),
        ...(metadata?.modelId ? { modelId: metadata.modelId } : {}),
        thinkingLevel: this.options.defaultThinkingLevel,
        mode,
      });
      return { cacheKey, session };
    } catch (error) {
      if (
        mode !== "recreate" ||
        metadata?.provider ||
        metadata?.modelId ||
        !String(error).includes("cannot be recreated without provider and model")
      ) {
        throw error;
      }

      const session = await this.createPersistentSession({
        cacheKey,
        backendCallContext,
        backendExecutionRef: target.backendExecutionRef,
        provider: this.options.defaultProvider,
        modelId: this.options.defaultModel,
        thinkingLevel: this.options.defaultThinkingLevel,
        mode,
      });
      return { cacheKey, session };
    }
  }

  private async disposeCachedSession(cacheKey: string): Promise<void> {
    const session = this.sessions.get(cacheKey);
    if (session) {
      await session.dispose();
    }
    this.sessions.delete(cacheKey);
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
      attachedExecutionSupervision: this.options.reuseSessions,
      durableFullFidelityResume: true,
    };
  }

  asAttachedExecutionSupervisor(): AttachedExecutionSupervisor | null {
    return this.options.reuseSessions ? this : null;
  }

  getObserverSnapshot(
    cacheKey: string,
    backendExecutionRef: string,
  ): PiSessionObserverSnapshot | null {
    const session = this.sessions.get(cacheKey);
    if (!session) {
      return null;
    }

    const runtime = session.getRuntimeSnapshot();
    const metadata = this.sessionMetadata.get(cacheKey) ?? {
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
        backend_execution_ref: backendExecutionRef,
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

  consumeQueuedSteering(
    target: SteeringTarget | null,
    sessionOverride?: { steer: (message: string) => void },
  ): string[] {
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
      boundTarget?.backendExecutionRef && boundTarget.runId
        ? this.sessions.get(
            this.getRunScopedSessionKey(boundTarget.runId, boundTarget.backendExecutionRef),
          )
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
    backendCallContext: BackendCallContext,
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
    const { cacheKey, session } = await this.ensureAttachedSession(
      target,
      context,
      backendCallContext,
    );
    this.consumeQueuedSteering(steeringTarget, session);

    const snapshot = this.getObserverSnapshot(cacheKey, target.backendExecutionRef);
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
    context: Context,
    backendCallContext: BackendCallContext,
  ): Promise<void> {
    const { session } = await this.ensureAttachedSession(target, context, backendCallContext);
    session.steer(message);
  }
}
