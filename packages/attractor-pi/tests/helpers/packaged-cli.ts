import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface PackagedRunResult {
  stdout: string;
  stderr: string;
}

export interface InstalledCliArtifact {
  installRoot: string;
  binPath: string;
  cleanup: () => void;
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

function runCommand(command: string, args: string[], cwd: string): void {
  try {
    execFileSync(command, args, {
      cwd,
      env: process.env,
      stdio: "pipe",
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr ?? "") : "";
    const stdout = error instanceof Error && "stdout" in error ? String(error.stdout ?? "") : "";
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
}

function packWorkspacePackage(workspaceRoot: string, packageDirName: string, tarballsDir: string): string {
  const packageDir = join(workspaceRoot, "packages", packageDirName);
  const before = new Set(readdirSync(tarballsDir));
  runCommand("pnpm", ["pack", "--pack-destination", tarballsDir], packageDir);
  const after = readdirSync(tarballsDir).filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
  if (after.length !== 1) {
    throw new Error(`Expected one tarball for ${packageDirName}, found ${after.length}.`);
  }
  return join(tarballsDir, after[0]!);
}

export function installPackedCliFromWorkspace(workspaceRoot: string): InstalledCliArtifact {
  const tempRoot = mkdtempSync(join(tmpdir(), "attractor-cli-install-"));
  const tarballsDir = join(tempRoot, "tarballs");
  const installRoot = join(tempRoot, "install");
  mkdirSync(tarballsDir, { recursive: true });
  mkdirSync(installRoot, { recursive: true });

  const coreTarball = packWorkspacePackage(workspaceRoot, "attractor-core", tarballsDir);
  const backendTarball = packWorkspacePackage(workspaceRoot, "backend-pi-dev", tarballsDir);
  const cliTarball = packWorkspacePackage(workspaceRoot, "attractor-cli", tarballsDir);

  runCommand("npm", ["init", "-y"], installRoot);
  runCommand("npm", ["install", "--no-package-lock", coreTarball, backendTarball, cliTarball], installRoot);

  return {
    installRoot,
    binPath: join(installRoot, "node_modules", ".bin", "attractor"),
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

async function runCommandWithOutput(
  command: string,
  args: string[],
  cwd: string,
  successMarker: (output: PackagedRunResult) => boolean,
  timeoutMs: number,
): Promise<PackagedRunResult> {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  await new Promise<void>((resolveRun, rejectRun) => {
    const timeout = setTimeout(() => {
      rejectRun(new Error(`Command timed out: ${command}`));
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
          `Command exited before success (code=${code}, signal=${signal})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        ),
      );
    });
  }).finally(async () => {
    await stopChild(child);
  });

  return { stdout, stderr };
}

export async function runPackagedCli(
  distEntry: string,
  args: string[],
  cwd: string,
  successMarker: (output: PackagedRunResult) => boolean,
  timeoutMs = 180_000,
): Promise<PackagedRunResult> {
  return runCommandWithOutput(process.execPath, [distEntry, ...args], cwd, successMarker, timeoutMs);
}

export async function runInstalledPackagedCli(
  binPath: string,
  args: string[],
  cwd: string,
  successMarker: (output: PackagedRunResult) => boolean,
  timeoutMs = 180_000,
): Promise<PackagedRunResult> {
  return runCommandWithOutput(binPath, args, cwd, successMarker, timeoutMs);
}
