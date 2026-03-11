import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createDebugAgentWriter } from "../src/debug-agent.js";
import { runCommand, shouldRunAsCliEntry, steerCommand } from "../src/index.js";

describe("debug agent writer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("writes redacted prompt, tool, and thread artifacts", () => {
    const logsRoot = mkdtempSync(join(tmpdir(), "attractor-debug-agent-"));
    tempDirs.push(logsRoot);

    const writer = createDebugAgentWriter(logsRoot);

    writer.writeSnapshot({
      phase: "before_submit",
      threadKey: "thread-1",
      provider: "anthropic",
      modelId: "claude-test",
      activeTools: ["read", "edit"],
      systemPrompt: "token=secret-value\napi_key=sk-abcdef1234567890",
      toolPolicyDiagnostics: ["diag"],
    });

    writer.writeEvent({
      kind: "tool_call_start",
      timestamp: Date.now(),
      sessionId: "session-1",
      data: {
        authorization: "Bearer very-secret-token",
        plain: "safe",
      },
    });

    const prompt = readFileSync(join(logsRoot, "system-prompt.md"), "utf-8");
    const tools = readFileSync(join(logsRoot, "active-tools.json"), "utf-8");
    const thread = readFileSync(join(logsRoot, "agent-thread.jsonl"), "utf-8");

    expect(prompt).toContain("token=secret-value");
    expect(tools).toContain("\"activeTools\"");
    expect(thread).toContain("[REDACTED]");
    expect(thread).not.toContain("very-secret-token");
  });

  it("writes debug agent artifacts from the real run command path", async () => {
    const root = mkdtempSync(join(tmpdir(), "attractor-cli-run-"));
    tempDirs.push(root);

    const dotPath = join(root, "workflow.dot");
    const logsPath = join(root, "logs");
    writeFileSync(
      dotPath,
      `digraph Test {
  graph [goal="Test debug artifacts"]
  start [shape=Mdiamond]
  exit [shape=Msquare]
  work [label="Work", prompt="Say hello"]
  start -> work -> exit
}
`,
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runCommand(
      [dotPath, "--logs-dir", logsPath, "--debug-agent"],
      {
        createBackend: (options) => ({
          async run() {
            options.onSessionSnapshot?.({
              phase: "before_submit",
              threadKey: "test-thread",
              provider: "anthropic",
              modelId: "claude-test",
              activeTools: ["read", "edit"],
              systemPrompt: "system prompt with api_key=secret-value",
              toolPolicyDiagnostics: ["diag"],
            });
            options.onSessionEvent?.({
              kind: "tool_call_start",
              timestamp: Date.now(),
              sessionId: "session-1",
              data: {
                authorization: "Bearer should-hide",
              },
            });
            return "ok";
          },
          async dispose() {},
        }),
      },
    );

    expect(existsSync(join(logsPath, "system-prompt.md"))).toBe(true);
    expect(existsSync(join(logsPath, "active-tools.json"))).toBe(true);
    expect(existsSync(join(logsPath, "agent-thread.jsonl"))).toBe(true);

    const prompt = readFileSync(join(logsPath, "system-prompt.md"), "utf-8");
    const tools = readFileSync(join(logsPath, "active-tools.json"), "utf-8");
    const thread = readFileSync(join(logsPath, "agent-thread.jsonl"), "utf-8");

    expect(prompt).toContain("system prompt");
    expect(tools).toContain("\"activeTools\"");
    expect(thread).toContain("[REDACTED]");
    expect(thread).not.toContain("should-hide");
  });

  it("treats a symlinked executable path as the CLI entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "attractor-cli-symlink-"));
    tempDirs.push(root);

    const realEntry = join(root, "real-entry.mjs");
    const linkedEntry = join(root, "linked-entry.mjs");
    writeFileSync(realEntry, "#!/usr/bin/env node\n");
    symlinkSync(realEntry, linkedEntry);

    expect(shouldRunAsCliEntry(linkedEntry, pathToFileURL(realEntry).href)).toBe(true);
  });

  it("sends steering requests through the HTTP API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await steerCommand([
      "run-42",
      "--message",
      "Tighten the scope",
      "--host",
      "127.0.0.1",
      "--port",
      "4111",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4111/pipelines/run-42/steer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Tighten the scope" }),
      }),
    );
  });
});
