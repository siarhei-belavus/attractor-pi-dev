import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PackagedRunResult {
  stdout: string;
  stderr: string;
}

export function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

export function getPiAgentDir(): string {
  return expandHome(process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent"));
}

export function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function resolveSmokeProvider(): string {
  if (process.env["ATTRACTOR_SMOKE_PROVIDER"]) {
    return process.env["ATTRACTOR_SMOKE_PROVIDER"]!;
  }
  const settings = readJson<{ defaultProvider?: string }>(join(getPiAgentDir(), "settings.json"));
  return settings?.defaultProvider ?? "anthropic";
}

export function hasProviderAuth(provider: string): boolean {
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

export async function stopChild(child: ChildProcessWithoutNullStreams | null): Promise<void> {
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

export async function runPackagedCli(
  distEntry: string,
  args: string[],
  cwd: string,
  successMarker: (output: PackagedRunResult) => boolean,
  timeoutMs = 180_000,
): Promise<PackagedRunResult> {
  const child = spawn(process.execPath, [distEntry, ...args], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  await new Promise<void>((resolveRun, rejectRun) => {
    const timeout = setTimeout(() => {
      rejectRun(new Error("Packaged CLI test timed out"));
    }, timeoutMs);

    const finishIfComplete = () => {
      if (!successMarker({ stdout, stderr })) {
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
      if (successMarker({ stdout, stderr })) {
        clearTimeout(timeout);
        resolveRun();
        return;
      }
      clearTimeout(timeout);
      rejectRun(
        new Error(
          `Packaged CLI exited before success (code=${code}, signal=${signal})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        ),
      );
    });
  }).finally(async () => {
    await stopChild(child);
  });

  return { stdout, stderr };
}
