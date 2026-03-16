import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasProviderAuth,
  installPackedCliFromWorkspace,
  readJson,
  resolveSmokeProvider,
  runInstalledPackagedCli,
} from "./helpers/packaged-cli.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const fixturePath = join(packageRoot, "tests", "fixtures", "debug-system-prompt-demo.dot");

const smokeProvider = resolveSmokeProvider();
const hasSmokeAuth = hasProviderAuth(smokeProvider);

interface NodeOutcomeRecord {
  status?: string;
  failureReason?: string;
}

interface CheckpointRecord {
  currentNode?: string;
  completedNodes?: string[];
  nodeOutcomes?: Record<string, NodeOutcomeRecord>;
  context?: Record<string, unknown>;
}

interface ManifestRecord {
  name?: string;
  goal?: string;
  startTime?: string;
}

interface ActiveToolsRecord {
  sessionKey?: string;
  nodeId?: string;
  provider?: string;
  modelId?: string;
  activeTools?: string[];
}

describe.skipIf(!hasSmokeAuth)("Packaged CLI smoke test", () => {
  let logsDir: string;
  let installRoot: string;
  let stdout = "";
  let stderr = "";
  let checkpoint: CheckpointRecord;
  let manifest: ManifestRecord;
  let snapshot: Record<string, unknown>;
  let activeTools: ActiveToolsRecord;
  let responseText = "";
  let statusText = "";
  let cleanupInstall: (() => void) | null = null;

  beforeAll(async () => {
    const installedCli = installPackedCliFromWorkspace(workspaceRoot);
    installRoot = installedCli.installRoot;
    cleanupInstall = installedCli.cleanup;
    logsDir = mkdtempSync(join(tmpdir(), "attractor-pi-smoke-"));
    const result = await runInstalledPackagedCli(
      installedCli.binPath,
      ["run", fixturePath, "--auto-approve", "--debug-agent", "--logs-dir", logsDir],
      installRoot,
      ({ stdout: currentStdout }) =>
        existsSync(join(logsDir, "checkpoint.json")) &&
        currentStdout.includes("Result: success"),
    );
    stdout = result.stdout;
    stderr = result.stderr;

    checkpoint = readJson<CheckpointRecord>(join(logsDir, "checkpoint.json")) ?? {};
    manifest = readJson<ManifestRecord>(join(logsDir, "manifest.json")) ?? {};
    snapshot =
      readJson<Record<string, unknown>>(
        join(logsDir, "debug", "threads", "ask", "latest-snapshot.json"),
      ) ?? {};
    activeTools = readJson<ActiveToolsRecord>(join(logsDir, "ask", "active-tools.json")) ?? {};
    responseText = readFileSync(join(logsDir, "ask", "response.md"), "utf-8");
    statusText = readFileSync(join(logsDir, "ask", "status.json"), "utf-8");
  }, 190_000);

  afterAll(() => {
    if (logsDir) {
      rmSync(logsDir, { recursive: true, force: true });
    }
    cleanupInstall?.();
  });

  it("runs the packaged attractor CLI end to end", () => {
    expect(existsSync(join(installRoot, "node_modules", ".bin", "attractor"))).toBe(true);
    expect(stdout).toContain("Result: success");
    expect(stdout).toContain("Completed: start -> ask -> exit");
    expect(stderr).not.toContain("Failure:");
    expect(checkpoint["nodeOutcomes"]?.["ask"]?.["status"]).toBe("success");
    expect(checkpoint["currentNode"]).toBe("exit");
    expect(checkpoint["completedNodes"]).toEqual(["start", "ask", "exit"]);
    expect(manifest["name"]).toBe("DebugSystemPromptDemo");
    expect(manifest["goal"]).toBe("Inspect backend system prompt in debug mode");
    expect(existsSync(join(logsDir, "ask", "prompt.md"))).toBe(true);
    expect(existsSync(join(logsDir, "ask", "response.md"))).toBe(true);
    expect(existsSync(join(logsDir, "ask", "status.json"))).toBe(true);
    expect(responseText.trim().length).toBeGreaterThan(0);
    expect(responseText).toContain("debug demo ok");
    expect(statusText).toContain("\"outcome\": \"success\"");
  });

  it("writes node-scoped and thread-scoped debug artifacts", () => {
    expect(existsSync(join(logsDir, "ask", "system-prompt.md"))).toBe(true);
    expect(existsSync(join(logsDir, "ask", "active-tools.json"))).toBe(true);
    expect(existsSync(join(logsDir, "debug", "threads", "ask", "session-events.jsonl"))).toBe(true);
    expect(existsSync(join(logsDir, "debug", "threads", "ask", "latest-snapshot.json"))).toBe(true);
    expect(existsSync(join(logsDir, "debug", "threads", "ask", "system-prompt.md"))).toBe(false);
  });

  it("captures debug metadata in the expected files", () => {
    expect(snapshot["sessionKey"]).toBe("ask");
    expect(snapshot["nodeId"]).toBe("ask");
    expect(snapshot["phase"]).toBe("after_submit");
    expect(String(snapshot["provider"] ?? "").length).toBeGreaterThan(0);
    expect(String(snapshot["modelId"] ?? "").length).toBeGreaterThan(0);
    expect(Array.isArray(snapshot["activeTools"])).toBe(true);
    expect(activeTools["sessionKey"]).toBe("ask");
    expect(activeTools["nodeId"]).toBe("ask");
    expect(activeTools["provider"]).toBe(snapshot["provider"]);
    expect(activeTools["modelId"]).toBe(snapshot["modelId"]);
    expect((activeTools["activeTools"] ?? []).length).toBeGreaterThan(0);
  });
});
