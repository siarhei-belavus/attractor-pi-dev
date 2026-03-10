import { describe, expect, it, vi } from "vitest";
import { Context } from "@attractor/core";
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
      context: Context.fromSnapshot({ "internal.last_completed_thread_key": "child-thread" }),
      graph: {} as any,
      logsRoot: "/tmp",
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

  it("steers a bound session by binding key", async () => {
    const backend = new PiAgentCodergenBackend({ reuseSessions: true }) as any;
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

    const result = await backend.steer("child-thread", "Keep going");

    expect(result.applied).toBe(true);
    expect(steerSpy).toHaveBeenCalledWith("Keep going");
  });
});
