import { describe, expect, it, vi } from "vitest";
import {
  applyManagerChildExecution,
  Context,
  createManagerChildExecution,
  createSteeringMessage,
  InMemorySteeringQueue,
} from "@attractor/core";
import { PiAgentCodergenBackend } from "../src/backend.js";
import { SessionState } from "../src/session.js";

const RESUME_CALL_CONTEXT = {
  runId: "run-1",
  logsRoot: "/tmp/run-1",
  sessionRoot: "/tmp/run-1/sessions",
  sessionAccessMode: "resume_strict" as const,
};

describe("Pi manager observer integration", () => {
  it("maps a bound session snapshot into manager observer telemetry", async () => {
    const backend = new PiAgentCodergenBackend({ reuseSessions: true }) as any;
    backend.sessions.set("run-1::child-thread", {
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
    backend.sessionMetadata.set("run-1::child-thread", {
      provider: "anthropic",
      modelId: "claude-test",
    });

    const snapshot = await backend.observeAttachedExecution(
      {
        backendExecutionRef: "child-thread",
      },
      Context.fromSnapshot({
        "internal.run_id": "run-1",
        "internal.manager_child_execution_id": "run-1:manager:attached-child",
        "internal.backend_session_persistence": "pi_manifest_v1",
      }),
      RESUME_CALL_CONTEXT,
    );

    expect(snapshot).toEqual({
      status: "running",
      telemetry: {
        session_state: SessionState.AWAITING_INPUT,
        awaiting_input: true,
        last_assistant_text: "Need clarification?",
        message_count: 4,
        active_tools: ["read", "edit"],
        tool_policy_diagnostics: ["diag"],
        backend_execution_ref: "child-thread",
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
    backend.sessions.set("run-1::child-thread", {
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

    expect(backend.getObserverSnapshot("run-1::child-thread", "child-thread")).toMatchObject({
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
    backend.sessions.set("run-1::child-thread", {
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
        target: { runId: "run-1", childExecutionId: "run-1:manager:attached-child" },
        message: "Keep going",
        source: "api",
      }),
    );
    backend.consumeQueuedSteering({
      runId: "run-1",
      childExecutionId: "run-1:manager:attached-child",
      backendExecutionRef: "child-thread",
    });

    expect(steerSpy).toHaveBeenCalledWith("Keep going");
  });

  it("delivers manager-originated queued steering during the observe cycle", async () => {
    const steeringQueue = new InMemorySteeringQueue();
    const backend = new PiAgentCodergenBackend({
      reuseSessions: true,
      steeringQueue,
    }) as any;
    const calls: string[] = [];

    backend.sessions.set("run-1::child-thread", {
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
    backend.sessionMetadata.set("run-1::child-thread", {
      provider: "anthropic",
      modelId: "claude-test",
    });

    steeringQueue.enqueue(
      createSteeringMessage({
        target: {
          runId: "run-1",
          childExecutionId: "run-1:manager:attached-child",
        },
        message: "Focus on the failing test first",
        source: "manager",
      }),
    );

    const context = new Context();
    context.set("internal.run_id", "run-1");
    context.set("internal.manager_child_execution_id", "run-1:manager:attached-child");
    context.set("internal.backend_session_persistence", "pi_manifest_v1");
    applyManagerChildExecution(
      context,
      createManagerChildExecution({
        id: "run-1:manager:attached-child",
        runId: "run-1",
        ownerNodeId: "manager",
        kind: "attached_backend_execution",
        autostart: false,
        attachedTarget: {
          backendExecutionRef: "child-thread",
          nodeId: "child",
        },
      }),
    );

    await backend.observeAttachedExecution(
      {
        backendExecutionRef: "child-thread",
        nodeId: "child",
      },
      context,
      RESUME_CALL_CONTEXT,
    );

    expect(calls).toEqual(["steer:Focus on the failing test first", "snapshot"]);
    expect(
      steeringQueue.peek({
        runId: "run-1",
        childExecutionId: "run-1:manager:attached-child",
      }),
    ).toEqual([]);
  });

  it("lazy-reopens an attached child session after cache loss", async () => {
    const backend = new PiAgentCodergenBackend({ reuseSessions: true }) as any;
    const fakeSession = {
      steer: vi.fn(),
      getRuntimeSnapshot: () => ({
        state: SessionState.AWAITING_INPUT,
        awaitingInput: true,
        lastAssistantText: "Recovered child",
        messageCount: 2,
        activeTools: [],
        toolPolicyDiagnostics: [],
        turnCount: 1,
        toolRoundCount: 1,
        lastActivityAt: 99,
        terminalOutcome: null,
        failureReason: null,
      }),
    };

    backend.ensureAttachedSession = vi.fn(async () => {
      backend.sessions.set("run-1::child-thread", fakeSession);
      backend.sessionMetadata.set("run-1::child-thread", {
        provider: "anthropic",
        modelId: "claude-test",
      });
      return {
        cacheKey: "run-1::child-thread",
        session: fakeSession,
      };
    });

    const snapshot = await backend.observeAttachedExecution(
      { backendExecutionRef: "child-thread" },
      Context.fromSnapshot({
        "internal.run_id": "run-1",
        "internal.backend_session_persistence": "pi_manifest_v1",
      }),
      RESUME_CALL_CONTEXT,
    );

    expect(backend.ensureAttachedSession).toHaveBeenCalled();
    expect(snapshot.status).toBe("running");
    expect(snapshot.telemetry?.backend_execution_ref).toBe("child-thread");
  });

  it("does not advertise attached supervision when session reuse is disabled", () => {
    const backend = new PiAgentCodergenBackend({ reuseSessions: false });

    expect(backend.getCapabilities()).toMatchObject({
      debugTelemetry: true,
      attachedExecutionSupervision: false,
      durableFullFidelityResume: true,
    });
    expect(backend.asAttachedExecutionSupervisor()).toBeNull();
  });
});
