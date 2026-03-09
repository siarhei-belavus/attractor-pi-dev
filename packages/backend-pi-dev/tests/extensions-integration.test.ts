import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgentCodergenBackend, Session, createAnthropicProfile } from "../src/index.js";

function writeExtension(path: string, toolName: string): void {
  writeFileSync(
    path,
    `
import { Type } from "@mariozechner/pi-ai";

export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(toolName)},
    label: ${JSON.stringify(toolName)},
    description: "test tool",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: ${JSON.stringify(`${toolName}-ok`)} }],
        details: {},
      };
    },
  });
}
`,
  );
}

describe("extensions integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("loads explicit allowlist extensions with discovery disabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "backend-pi-ext-"));
    tempDirs.push(cwd);

    const allowlistedExtension = join(cwd, "allowlisted.ts");
    const discoveredDir = join(cwd, ".pi", "extensions");
    const discoveredExtension = join(discoveredDir, "discovered.ts");

    mkdirSync(discoveredDir, { recursive: true });
    writeExtension(allowlistedExtension, "allowlisted_tool");
    writeExtension(discoveredExtension, "discovered_tool");

    const profile = createAnthropicProfile({ cwd });
    const session = new Session({
      profile,
      resourcePolicy: {
        discovery: "none",
        allowlist: [allowlistedExtension],
      },
    });

    await session.initialize();

    expect(session.getActiveToolNames()).toContain("allowlisted_tool");
    expect(session.getActiveToolNames()).not.toContain("discovered_tool");
    expect(session.session?.getAllTools().map((tool) => tool.name)).toContain(
      "allowlisted_tool",
    );

    await session.dispose();
  });

  it("emits a non-blank debug snapshot when initialization fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "backend-pi-fail-"));
    tempDirs.push(cwd);

    const snapshots: Array<{
      phase: string;
      activeTools: string[];
      systemPrompt: string;
    }> = [];

    const initializeSpy = vi
      .spyOn(Session.prototype, "initialize")
      .mockImplementation(async function mockInitialize(this: Session) {
        (this as Session & { preparedSystemPrompt?: string }).preparedSystemPrompt =
          "prepared prompt";
        (this as Session & { projectedActiveToolNames?: string[] }).projectedActiveToolNames = [
          "read",
          "edit",
        ];
        throw new Error("broken extension startup");
      });

    const backend = new PiAgentCodergenBackend({
      cwd,
      onSessionSnapshot: (snapshot) => {
        snapshots.push({
          phase: snapshot.phase,
          activeTools: snapshot.activeTools,
          systemPrompt: snapshot.systemPrompt,
        });
      },
    });

    const result = await backend.run(
      {
        id: "plan",
        classes: [],
      } as any,
      "hello",
      {} as any,
    );

    expect(typeof result).not.toBe("string");
    expect(result).toMatchObject({ status: "fail" });
    expect(String((result as { failureReason?: string }).failureReason)).toContain(
      "Agent initialization failed",
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.phase).toBe("before_submit");
    expect(snapshots[0]!.systemPrompt.length).toBeGreaterThan(0);
    expect(snapshots[0]!.activeTools.length).toBeGreaterThan(0);
    await backend.dispose();
  });
});
