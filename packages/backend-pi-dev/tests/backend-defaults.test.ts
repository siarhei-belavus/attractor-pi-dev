import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentCodergenBackend } from "../src/backend.js";

describe("PiAgentCodergenBackend defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads default provider and model from pi settings", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-settings-"));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.3-codex",
      }),
      "utf-8",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const backend = new PiAgentCodergenBackend();

    expect((backend as any).options.defaultProvider).toBe("openai-codex");
    expect((backend as any).options.defaultModel).toBe("gpt-5.3-codex");

    rmSync(agentDir, { recursive: true, force: true });
  });

  it("prefers explicit backend options over pi settings defaults", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-settings-"));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.3-codex",
      }),
      "utf-8",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const backend = new PiAgentCodergenBackend({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5-20250929",
    });

    expect((backend as any).options.defaultProvider).toBe("anthropic");
    expect((backend as any).options.defaultModel).toBe("claude-sonnet-4-5-20250929");

    rmSync(agentDir, { recursive: true, force: true });
  });
});
