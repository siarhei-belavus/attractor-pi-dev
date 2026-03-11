import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface GoldenSeed {
  cliArgs?: string[];
  env?: Record<string, string>;
}

export interface GoldenSnapshot {
  scenario: string;
  cli: {
    exitCode: number | null;
    stdout: string[];
    stderr: string[];
  };
  run: {
    manifest: Record<string, unknown> | null;
    checkpoint: Record<string, unknown> | null;
    artifacts: {
      stageStatus: Record<string, unknown>;
      prompts: Record<string, string>;
      responses: Record<string, string>;
      managerLoops: Record<string, unknown>;
      questions: Record<string, unknown>;
    };
  };
}

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(helperDir, "../..");
const repoRoot = path.resolve(cliPackageRoot, "../..");
const goldenRoot = path.join(cliPackageRoot, "tests", "golden");
const workflowsDir = path.join(goldenRoot, "workflows");
const seedDir = path.join(goldenRoot, "seed");
const expectedDir = path.join(goldenRoot, "expected");
const cliEntryPoint = path.join(cliPackageRoot, "dist", "index.js");

let buildPromise: Promise<void> | null = null;

export function listGoldenScenarios(): string[] {
  return fs
    .readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith(".dot"))
    .map((entry) => entry.replace(/\.dot$/u, ""))
    .sort();
}

export function getExpectedPath(scenario: string): string {
  return path.join(expectedDir, `${scenario}.json`);
}

export async function runGoldenScenario(scenario: string): Promise<GoldenSnapshot> {
  await ensureCliBuilt();

  const workflowPath = path.join(workflowsDir, `${scenario}.dot`);
  const seed = loadSeed(scenario);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `attractor-golden-${scenario}-`));
  const logsDir = path.join(tempRoot, "logs");
  const args = [
    cliEntryPoint,
    "run",
    workflowPath,
    "--logs-dir",
    logsDir,
    "--simulate",
    ...(seed.cliArgs ?? []),
  ];

  try {
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        ...seed.env,
      },
    });

    return normalizeSnapshot({
      scenario,
      tempRoot,
      logsDir,
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function ensureCliBuilt(): Promise<void> {
  if (!buildPromise) {
    buildPromise = Promise.resolve().then(() => {
      for (const pkg of ["@attractor/core", "@attractor/backend-pi-dev", "@attractor/cli"]) {
        execFileSync(resolvePnpmBinary(), ["--filter", pkg, "build"], {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: "pipe",
        });
      }
    });
  }
  return buildPromise;
}

function loadSeed(scenario: string): GoldenSeed {
  const seedPath = path.join(seedDir, `${scenario}.json`);
  if (!fs.existsSync(seedPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(seedPath, "utf-8")) as GoldenSeed;
}

function normalizeSnapshot(input: {
  scenario: string;
  tempRoot: string;
  logsDir: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): GoldenSnapshot {
  return {
    scenario: input.scenario,
    cli: {
      exitCode: input.exitCode,
      stdout: normalizeOutput(input.stdout, input.tempRoot, input.logsDir),
      stderr: normalizeOutput(input.stderr, input.tempRoot, input.logsDir),
    },
    run: {
      manifest: normalizeJsonFile(path.join(input.logsDir, "manifest.json"), input.tempRoot, input.logsDir),
      checkpoint: normalizeCheckpoint(
        path.join(input.logsDir, "checkpoint.json"),
        input.tempRoot,
        input.logsDir,
      ),
      artifacts: {
        stageStatus: collectStageArtifacts(input.logsDir, "status.json", input.tempRoot, input.logsDir),
        prompts: collectTextArtifacts(input.logsDir, "prompt.md", input.tempRoot, input.logsDir),
        responses: collectTextArtifacts(input.logsDir, "response.md", input.tempRoot, input.logsDir),
        managerLoops: collectStageArtifacts(
          input.logsDir,
          "manager_loop.json",
          input.tempRoot,
          input.logsDir,
        ),
        questions: collectQuestionArtifacts(input.logsDir, input.tempRoot, input.logsDir),
      },
    },
  };
}

function normalizeCheckpoint(
  checkpointPath: string,
  tempRoot: string,
  logsDir: string,
): Record<string, unknown> | null {
  const checkpoint = normalizeJsonFile(checkpointPath, tempRoot, logsDir);
  if (!checkpoint) {
    return null;
  }

  const source = checkpoint as Record<string, unknown>;
  const context = source.context;

  return sortValue({
    currentNode: source.currentNode ?? "",
    completedNodes: source.completedNodes ?? [],
    nodeOutcomes: source.nodeOutcomes ?? {},
    nodeRetries: source.nodeRetries ?? {},
    waitingForQuestionId: source.waitingForQuestionId ?? "",
    context:
      context && typeof context === "object"
        ? filterContext(context as Record<string, unknown>)
        : {},
  }) as Record<string, unknown>;
}

function filterContext(context: Record<string, unknown>): Record<string, unknown> {
  const filteredEntries = Object.entries(context)
    .filter(([key]) => !key.startsWith("internal."))
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(filteredEntries.map(([key, value]) => [key, sortValue(value)]));
}

function collectStageArtifacts(
  logsDir: string,
  filename: string,
  tempRoot: string,
  runLogsDir: string,
): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {};
  for (const entry of listStageDirectories(logsDir)) {
    const filePath = path.join(logsDir, entry, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    artifacts[entry] = normalizeJsonFile(filePath, tempRoot, runLogsDir);
  }
  return sortValue(artifacts) as Record<string, unknown>;
}

function collectTextArtifacts(
  logsDir: string,
  filename: string,
  tempRoot: string,
  runLogsDir: string,
): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const entry of listStageDirectories(logsDir)) {
    const filePath = path.join(logsDir, entry, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    artifacts[entry] = normalizeString(fs.readFileSync(filePath, "utf-8"), tempRoot, runLogsDir);
  }
  return Object.fromEntries(
    Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function collectQuestionArtifacts(
  logsDir: string,
  tempRoot: string,
  runLogsDir: string,
): Record<string, unknown> {
  const questionsDir = path.join(logsDir, "questions");
  if (!fs.existsSync(questionsDir)) {
    return {};
  }

  const records: Record<string, unknown> = {};
  for (const entry of fs.readdirSync(questionsDir).filter((name) => name.endsWith(".json")).sort()) {
    records[entry] = normalizeJsonFile(path.join(questionsDir, entry), tempRoot, runLogsDir);
  }
  return sortValue(records) as Record<string, unknown>;
}

function listStageDirectories(logsDir: string): string[] {
  return fs
    .readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "questions" && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function normalizeJsonFile(
  filePath: string,
  tempRoot: string,
  logsDir: string,
): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  return sortValue(normalizeUnknown(raw, tempRoot, logsDir)) as Record<string, unknown>;
}

function normalizeUnknown(value: unknown, tempRoot: string, logsDir: string): unknown {
  if (typeof value === "string") {
    return normalizeString(value, tempRoot, logsDir);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnknown(item, tempRoot, logsDir));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !isTimestampKey(key))
        .map(([key, nested]) => [key, normalizeUnknown(nested, tempRoot, logsDir)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}

function normalizeOutput(output: string, tempRoot: string, logsDir: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => normalizeString(line, tempRoot, logsDir).trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("["))
    .filter((line) => !line.startsWith("Logs:"));
}

function normalizeString(value: string, tempRoot: string, logsDir: string): string {
  return value
    .replaceAll(tempRoot, "<TMP_ROOT>")
    .replaceAll(logsDir, "<LOGS_DIR>")
    .replaceAll(workflowsDir, "<WORKFLOWS_DIR>")
    .replaceAll(repoRoot, "<REPO_ROOT>");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, sortValue(nested)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}

function isTimestampKey(key: string): boolean {
  return (
    key === "timestamp" ||
    key === "startTime" ||
    key.endsWith("At") ||
    key.endsWith("_at") ||
    key === "updatedAt"
  );
}

function resolvePnpmBinary(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
