import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context, StageStatus } from "@attractor/core";
import { PiAgentCodergenBackend } from "../src/backend.js";
import { Session, SessionState, type SessionRuntimeSnapshot } from "../src/session.js";
import { createSubagentTools } from "../src/tools/subagent.js";

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

const BACKEND_CALL_CONTEXT = {
  runId: "run-1",
  logsRoot: "/tmp/run-1",
  sessionRoot: "/tmp/run-1/sessions",
  sessionAccessMode: "fresh",
  workflowBaseDir: null,
} as const;

const BASE_SNAPSHOT: SessionRuntimeSnapshot = {
  state: SessionState.IDLE,
  awaitingInput: false,
  lastAssistantText: "",
  messageCount: 1,
  activeTools: [],
  toolPolicyDiagnostics: [],
  turnCount: 1,
  toolRoundCount: 0,
  lastActivityAt: null,
  terminalOutcome: "success",
  failureReason: null,
};

function textFromToolResult(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("Pi backend turn-result extraction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns finalized assistant text from the stable runtime snapshot when the ambient getter is blank", async () => {
    const backend = new PiAgentCodergenBackend() as PiAgentCodergenBackend & {
      ensureRunSession: ReturnType<typeof vi.fn>;
    };
    const session = {
      submit: vi.fn(async () => undefined),
      getRuntimeSnapshot: vi.fn(() => ({
        ...BASE_SNAPSHOT,
        lastAssistantText: "Final authored answer",
      })),
      getLastAssistantText: vi.fn(() => ""),
    };
    backend.ensureRunSession = vi.fn(async () => session as any);

    const result = await backend.run(
      { id: "node-a", classes: [], attrs: {} } as any,
      "hello",
      new Context(),
      BACKEND_CALL_CONTEXT,
    );

    expect(result).toBe("Final authored answer");
    expect(session.submit).toHaveBeenCalledWith("hello");
  });

  it("does not collapse a workbook-like completed turn with artifacts and validation output into empty-response failure", async () => {
    const logsRoot = mkdtempSync(join(tmpdir(), "turn-result-extraction-"));
    mkdirSync(join(logsRoot, "authored"), { recursive: true });
    mkdirSync(join(logsRoot, "scratch", "validation"), { recursive: true });
    writeFileSync(
      join(logsRoot, "authored", "import-analysis.md"),
      "# Import Analysis\n\nArtifact body",
    );
    writeFileSync(
      join(logsRoot, "scratch", "validation", "latest-turn.json"),
      JSON.stringify({
        failureReason:
          "IMPORT_ARTIFACT_CONTRACT_INVALID: import-analysis heading count mismatch. Expected 8, received 9.",
      }),
    );

    const backend = new PiAgentCodergenBackend() as PiAgentCodergenBackend & {
      ensureRunSession: ReturnType<typeof vi.fn>;
    };
    backend.ensureRunSession = vi.fn(async () => ({
      submit: async () => undefined,
      getRuntimeSnapshot: () => ({
        ...BASE_SNAPSHOT,
        lastAssistantText: "Wrote import-analysis.md and validation details.",
      }),
      getLastAssistantText: () => "",
    }));

    const result = await backend.run(
      { id: "run_workbook_agent", classes: [], attrs: {} } as any,
      "produce workbook artifacts",
      new Context(),
      {
        ...BACKEND_CALL_CONTEXT,
        logsRoot,
        sessionRoot: join(logsRoot, "sessions"),
      },
    );

    expect(result).toBe("Wrote import-analysis.md and validation details.");
    expect(result).not.toEqual({
      status: StageStatus.FAIL,
      failureReason: "Agent returned empty response",
    });
  });

  it("uses the same stable turn result for successful subagent completion output", async () => {
    vi.spyOn(Session.prototype, "submit").mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, "getRuntimeSnapshot").mockReturnValue({
      ...BASE_SNAPSHOT,
      lastAssistantText: "stable child result",
    });
    vi.spyOn(Session.prototype, "dispose").mockResolvedValue(undefined);

    const tools = createSubagentTools({} as Session, TEST_PROFILE as any);
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
    const waitTool = tools.find((tool) => tool.name === "wait");
    if (!spawnTool || !waitTool) {
      throw new Error("Missing subagent tools");
    }

    const spawnResult = await spawnTool.execute("tool-1", { task: "child task" }, undefined);
    const spawnedText = textFromToolResult(spawnResult as any);
    const agentId = spawnedText.match(/ID: ([^\n]+)/)?.[1];
    if (!agentId) {
      throw new Error(`Unable to parse subagent id from: ${spawnedText}`);
    }

    const waitResult = await waitTool.execute("tool-2", { agent_id: agentId });
    const waitText = textFromToolResult(waitResult as any);

    expect(waitText).toContain("Status: completed");
    expect(waitText).toContain("stable child result");
  });

  it("maps terminal-failed subagents from the same runtime snapshot contract", async () => {
    vi.spyOn(Session.prototype, "submit").mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, "getRuntimeSnapshot").mockReturnValue({
      ...BASE_SNAPSHOT,
      terminalOutcome: "fail",
      failureReason: "Validation failed: heading count mismatch",
      lastAssistantText: "stale success text should not win",
    });
    vi.spyOn(Session.prototype, "dispose").mockResolvedValue(undefined);

    const tools = createSubagentTools({} as Session, TEST_PROFILE as any);
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
    const waitTool = tools.find((tool) => tool.name === "wait");
    if (!spawnTool || !waitTool) {
      throw new Error("Missing subagent tools");
    }

    const spawnResult = await spawnTool.execute("tool-1", { task: "child task" }, undefined);
    const spawnedText = textFromToolResult(spawnResult as any);
    const agentId = spawnedText.match(/ID: ([^\n]+)/)?.[1];
    if (!agentId) {
      throw new Error(`Unable to parse subagent id from: ${spawnedText}`);
    }

    const waitResult = await waitTool.execute("tool-2", { agent_id: agentId });
    const waitText = textFromToolResult(waitResult as any);

    expect(waitText).toContain("Status: failed");
    expect(waitText).toContain("Validation failed: heading count mismatch");
    expect(waitText).not.toContain("stale success text should not win");
  });
});
