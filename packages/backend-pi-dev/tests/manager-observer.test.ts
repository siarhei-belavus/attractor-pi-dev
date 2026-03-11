import { describe, expect, it, vi } from "vitest";
import { Context, InMemorySteeringQueue, createSteeringMessage } from "@attractor/core";
import { PiAgentCodergenBackend } from "../src/backend.js";
import { SessionState } from "../src/session.js";

describe("Pi manager observer integration", () => {
  it("maps a bound session snapshot into manager observer telemetry", async () => {
    const backend = new PiAgentCodergenBackend({ reuseSessions: true }) as any;
    backend.sessions.set("child-thread", {
      getRuntimeSnapshot: () => ({
        state: SessionState.AWAITING_INPUT,
        awaitingInput: true,
        lastAssistantText: "Need clarification?",
        messageCount: 4,
        activeTools: ["read", "edit"],
        toolPolicyDiagnostics: ["diag"],
        turnCount: 2,
        toolRoundCount: 3,
        lastActivityAt: 123,
        terminalOutcome: null,
        failureReason: null,
      }),
      steer: vi.fn(),
    });
    backend.sessionMetadata.set("child-thread", {
      provider: "anthropic",
      modelId: "claude-test",
    });

    const factory = backend.createManagerObserverFactory();
    const observer = await factory({
      node: {
        id: "manager",
        label: "Manager",
        shape: "house",
        type: "stack.manager_loop",
        prompt: "",
        maxRetries: 0,
        goalGate: false,
        retryTarget: "",
        fallbackRetryTarget: "",
        fidelity: "",
        threadId: "",
        classes: [],
        timeout: null,
        llmModel: "",
        llmProvider: "",
        reasoningEffort: "",
        autoStatus: false,
        allowPartial: false,
        attrs: {},
      },
      context: Context.fromSnapshot({
        "internal.run_id": "run-1",
        "internal.last_completed_execution_id": "child-thread",
      }),
      graph: {} as any,
      logsRoot: "/tmp",
      steeringQueue: new InMemorySteeringQueue(),
    });

    const snapshot = await observer!.observe(new Context());

    expect(snapshot).toEqual({
      childStatus: "running",
      telemetry: {
        session_state: SessionState.AWAITING_INPUT,
        awaiting_input: true,
        last_assistant_text: "Need clarification?",
        message_count: 4,
        active_tools: ["read", "edit"],
        tool_policy_diagnostics: ["diag"],
        thread_key: "child-thread",
        provider: "anthropic",
        model_id: "claude-test",
        turn_count: 2,
        tool_round_count: 3,
        last_activity_at: 123,
      },
    });
  });

  it("maps terminal success into a resolved lock decision", () => {
    const backend = new PiAgentCodergenBackend({ reuseSessions: true }) as any;
    backend.sessions.set("child-thread", {
      getRuntimeSnapshot: () => ({
        state: SessionState.CLOSED,
        awaitingInput: false,
        lastAssistantText: "All done",
        messageCount: 5,
        activeTools: [],
        toolPolicyDiagnostics: [],
        turnCount: 3,
        toolRoundCount: 3,
        lastActivityAt: 456,
        terminalOutcome: "success",
        failureReason: null,
      }),
      steer: vi.fn(),
    });

    expect(backend.getObserverSnapshot("child-thread")).toMatchObject({
      childStatus: "completed",
      childOutcome: "success",
      childLockDecision: "resolved",
    });
  });

  it("drains queued steering into a bound session", async () => {
    const steeringQueue = new InMemorySteeringQueue();
    const backend = new PiAgentCodergenBackend({
      reuseSessions: true,
      steeringQueue,
    }) as any;
    const steerSpy = vi.fn();
    backend.sessions.set("child-thread", {
      steer: steerSpy,
      getRuntimeSnapshot: () => ({
        state: SessionState.PROCESSING,
        awaitingInput: false,
        lastAssistantText: "",
        messageCount: 0,
        activeTools: [],
        toolPolicyDiagnostics: [],
        turnCount: 0,
        toolRoundCount: 0,
        lastActivityAt: null,
        terminalOutcome: null,
        failureReason: null,
      }),
    });

    steeringQueue.enqueue(
      createSteeringMessage({
        target: { runId: "run-1", executionId: "child-thread" },
        message: "Keep going",
        source: "api",
      }),
    );
    backend.consumeQueuedSteering({ runId: "run-1", executionId: "child-thread" });

    expect(steerSpy).toHaveBeenCalledWith("Keep going");
  });

  it("delivers manager-originated queued steering during the observe cycle", async () => {
    const steeringQueue = new InMemorySteeringQueue();
    const backend = new PiAgentCodergenBackend({
      reuseSessions: true,
      steeringQueue,
    }) as any;
    const calls: string[] = [];

    backend.sessions.set("child-thread", {
      steer: vi.fn((message: string) => {
        calls.push(`steer:${message}`);
      }),
      getRuntimeSnapshot: () => {
        calls.push("snapshot");
        return {
          state: SessionState.AWAITING_INPUT,
          awaitingInput: true,
          lastAssistantText: "Need clarification?",
          messageCount: 4,
          activeTools: ["read", "edit"],
          toolPolicyDiagnostics: ["diag"],
          turnCount: 2,
          toolRoundCount: 3,
          lastActivityAt: 123,
          terminalOutcome: null,
          failureReason: null,
        };
      },
    });
    backend.sessionMetadata.set("child-thread", {
      provider: "anthropic",
      modelId: "claude-test",
    });

    steeringQueue.enqueue(
      createSteeringMessage({
        target: {
          runId: "run-1",
          executionId: "child-thread",
          nodeId: "child",
        },
        message: "Focus on the failing test first",
        source: "manager",
      }),
    );

    const factory = backend.createManagerObserverFactory();
    const observer = await factory({
      node: {
        id: "manager",
        label: "Manager",
        shape: "house",
        type: "stack.manager_loop",
        prompt: "",
        maxRetries: 0,
        goalGate: false,
        retryTarget: "",
        fallbackRetryTarget: "",
        fidelity: "",
        threadId: "",
        classes: [],
        timeout: null,
        llmModel: "",
        llmProvider: "",
        reasoningEffort: "",
        autoStatus: false,
        allowPartial: false,
        attrs: {},
      },
      context: Context.fromSnapshot({
        "internal.run_id": "run-1",
        "internal.last_completed_execution_id": "child-thread",
        "internal.last_completed_node_id": "child",
      }),
      graph: {} as any,
      logsRoot: "/tmp",
      steeringQueue,
    });

    await observer!.observe(new Context());

    expect(calls).toEqual([
      "steer:Focus on the failing test first",
      "snapshot",
    ]);
    expect(
      steeringQueue.peek({
        runId: "run-1",
        executionId: "child-thread",
        nodeId: "child",
      }),
    ).toEqual([]);
  });
});
