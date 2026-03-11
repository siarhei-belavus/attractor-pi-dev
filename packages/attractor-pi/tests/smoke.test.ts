import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const distEntry = join(packageRoot, "dist", "attractor.mjs");
const fixturePath = join(packageRoot, "tests", "fixtures", "debug-system-prompt-demo.dot");

function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function getPiAgentDir(): string {
  return expandHome(process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent"));
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolveSmokeProvider(): string {
  if (process.env["ATTRACTOR_SMOKE_PROVIDER"]) {
    return process.env["ATTRACTOR_SMOKE_PROVIDER"]!;
  }
  const settings = readJson<{ defaultProvider?: string }>(join(getPiAgentDir(), "settings.json"));
  return settings?.defaultProvider ?? "anthropic";
}

function hasProviderAuth(provider: string): boolean {
  const auth = readJson<Record<string, unknown>>(join(getPiAgentDir(), "auth.json")) ?? {};
  if (provider in auth) {
    return true;
  }
  switch (provider) {
    case "anthropic":
      return !!process.env["ANTHROPIC_API_KEY"];
    case "openai":
    case "openai-codex":
    case "azure-openai-responses":
      return !!process.env["OPENAI_API_KEY"];
    case "google":
    case "google-gemini-cli":
    case "google-vertex":
      return !!process.env["GOOGLE_API_KEY"];
    default:
      return false;
  }
}

const smokeProvider = resolveSmokeProvider();
const hasSmokeAuth = hasProviderAuth(smokeProvider);

async function stopChild(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function runPackagedSmoke(logsDir: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [distEntry, "run", fixturePath, "--auto-approve", "--debug-agent", "--logs-dir", logsDir],
    {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  await new Promise<void>((resolveRun, rejectRun) => {
    const timeout = setTimeout(() => {
      rejectRun(new Error("Packaged smoke test timed out"));
    }, 180_000);

    const finishIfComplete = () => {
      if (!stdout.includes("Result: success")) {
        return;
      }
      if (!existsSync(join(logsDir, "checkpoint.json"))) {
        return;
      }
      clearTimeout(timeout);
      resolveRun();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      finishIfComplete();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      finishIfComplete();
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      rejectRun(err);
    });
    child.once("exit", (code, signal) => {
      if (stdout.includes("Result: success")) {
        clearTimeout(timeout);
        resolveRun();
        return;
      }
      clearTimeout(timeout);
      rejectRun(
        new Error(
          `Packaged smoke test exited before success (code=${code}, signal=${signal})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        ),
      );
    });
  }).finally(async () => {
    await stopChild(child);
  });

  return { stdout, stderr };
}

describe.skipIf(!hasSmokeAuth)("Packaged CLI smoke test", () => {
  let logsDir: string;
  let stdout = "";
  let stderr = "";
  let checkpoint: Record<string, any>;
  let snapshot: Record<string, any>;

  beforeAll(async () => {
    logsDir = mkdtempSync(join(tmpdir(), "attractor-pi-smoke-"));
    const result = await runPackagedSmoke(logsDir);
    stdout = result.stdout;
    stderr = result.stderr;

    checkpoint = readJson<Record<string, any>>(join(logsDir, "checkpoint.json")) ?? {};
    snapshot =
      readJson<Record<string, any>>(
        join(logsDir, "debug", "threads", "ask", "latest-snapshot.json"),
      ) ?? {};
  }, 190_000);

  afterAll(() => {
    if (logsDir) {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it("runs the packaged attractor CLI against a real LLM", () => {
    expect(stdout).toContain("Result: success");
    expect(stdout).toContain("Completed: start -> ask -> exit");
    expect(stderr).not.toContain("Failure:");
    expect(checkpoint["nodeOutcomes"]?.["ask"]?.["status"]).toBe("success");
    expect(existsSync(join(logsDir, "ask", "response.md"))).toBe(true);
    expect(readFileSync(join(logsDir, "ask", "response.md"), "utf-8").trim().length).toBeGreaterThan(0);
  });

  it("writes node-scoped debug artifacts for the packaged run", () => {
    expect(existsSync(join(logsDir, "ask", "system-prompt.md"))).toBe(true);
    expect(existsSync(join(logsDir, "ask", "active-tools.json"))).toBe(true);
    expect(existsSync(join(logsDir, "debug", "threads", "ask", "latest-snapshot.json"))).toBe(true);
    expect(existsSync(join(logsDir, "debug", "threads", "ask", "system-prompt.md"))).toBe(false);
    expect(snapshot["nodeId"]).toBe("ask");
    expect(String(snapshot["provider"] ?? "").length).toBeGreaterThan(0);
    expect(String(snapshot["modelId"] ?? "").length).toBeGreaterThan(0);
  });
});
