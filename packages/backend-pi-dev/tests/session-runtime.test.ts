import { describe, expect, it } from "vitest";
import { Session, SessionState } from "../src/session.js";

const TEST_PROFILE = {
  id: "test",
  model: { name: "test-model", contextWindow: 8192 } as any,
  tools: [],
  toolNames: [],
  defaultThinkingLevel: "medium",
  defaultCommandTimeoutMs: 1000,
  supportsParallelToolCalls: false,
  supportsReasoning: true,
  contextWindowSize: 8192,
  truncation: { charLimits: {}, lineLimits: {}, modes: {} },
  baseInstructions: "",
  projectDocPatterns: [],
} as const;

describe("Session runtime outcome tracking", () => {
  it("preserves finalized assistant text for the completed submit when the ambient getter is blank", async () => {
    const session = new Session({ profile: TEST_PROFILE });
    const finalizedAssistantText = "Which import strategy should I use?";

    (session as any).initialize = async () => {
      (session as any).agentSession = {
        prompt: async () => {
          (session as any).handleAgentEvent({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: finalizedAssistantText }],
            },
          });
        },
        agent: {
          waitForIdle: async () => undefined,
        },
        getLastAssistantText: () => "",
        messages: [{ role: "assistant" }],
        getActiveToolNames: () => [],
      };
    };

    await session.submit("hello");

    const snapshot = session.getRuntimeSnapshot();
    expect(snapshot.lastAssistantText).toBe(finalizedAssistantText);
    expect(snapshot.state).toBe(SessionState.AWAITING_INPUT);
    expect(snapshot.awaitingInput).toBe(true);
    expect(snapshot.terminalOutcome).toBeNull();
  });

  it("preserves failure outcome after a recoverable submit error", async () => {
    const session = new Session({ profile: TEST_PROFILE });

    (session as any).initialize = async () => {
      (session as any).agentSession = {
        prompt: async () => {
          throw new Error("temporary backend failure");
        },
        agent: {
          waitForIdle: async () => undefined,
        },
        getLastAssistantText: () => "",
        messages: [],
        getActiveToolNames: () => [],
      };
    };

    await session.submit("hello");

    const snapshot = session.getRuntimeSnapshot();
    expect(snapshot.state).toBe(SessionState.IDLE);
    expect(snapshot.terminalOutcome).toBe("fail");
    expect(snapshot.failureReason).toContain("temporary backend failure");
  });
});
