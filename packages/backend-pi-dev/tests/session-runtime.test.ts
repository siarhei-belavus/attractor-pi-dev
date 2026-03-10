import { describe, expect, it } from "vitest";
import { Session, SessionState } from "../src/session.js";

describe("Session runtime outcome tracking", () => {
  it("preserves failure outcome after a recoverable submit error", async () => {
    const session = new Session({
      profile: {
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
      },
    });

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
