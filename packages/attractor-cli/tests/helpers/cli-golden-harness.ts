import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface GoldenSeed {
  cliArgs?: string[];
  env?: Record<string, string>;
  files?: Record<string, string | Record<string, unknown>>;
  testConfig?: Record<string, unknown>;
}

export interface GoldenSnapshot {
  scenario: string;
  cli: {
    exitCode: number | null;
    stdout: string[];
    stderr: string[];
  };
  run: {
    outcome: {
      status: string;
      failureReason: string;
    };
    currentNode: string;
    completedNodes: string[];
    waitingForQuestionId: string;
    keyContext: Record<string, unknown>;
    artifacts: {
      nodeStatus: Record<string, unknown>;
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
    .filter((entry) => entry.endsWith(".dot") && !entry.endsWith(".child.dot"))
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
  const materializedSeed = materializeSeed(seed, tempRoot, scenario);
  const logsDir = path.join(tempRoot, "logs");
  const args = [
    cliEntryPoint,
    "run",
    workflowPath,
    "--logs-dir",
    logsDir,
    "--simulate",
    ...(materializedSeed.cliArgs ?? []),
  ];

  try {
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        ...materializedSeed.env,
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

function materializeSeed(
  seed: GoldenSeed,
  tempRoot: string,
  scenario: string,
): Required<Pick<GoldenSeed, "cliArgs" | "env">> {
  if (seed.files) {
    for (const [relativePath, rawContent] of Object.entries(seed.files)) {
      const filePath = path.join(tempRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const content = resolvePlaceholders(rawContent, tempRoot, scenario);
      if (typeof content === "string") {
        fs.writeFileSync(filePath, content);
      } else {
        fs.writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`);
      }
    }
  }

  const env = resolvePlaceholders(seed.env ?? {}, tempRoot, scenario) as Record<string, string>;
  if (seed.testConfig) {
    const configPath = path.join(tempRoot, "cli-test-config.json");
    const resolvedConfig = resolvePlaceholders(seed.testConfig, tempRoot, scenario);
    fs.writeFileSync(configPath, `${JSON.stringify(resolvedConfig, null, 2)}\n`);
    env.ATTRACTOR_CLI_TEST_CONFIG = configPath;
  }

  return {
    cliArgs: resolvePlaceholders(seed.cliArgs ?? [], tempRoot, scenario) as string[],
    env,
  };
}

function normalizeSnapshot(input: {
  scenario: string;
  tempRoot: string;
  logsDir: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): GoldenSnapshot {
  const checkpoint = normalizeCheckpoint(
    path.join(input.logsDir, "checkpoint.json"),
    input.tempRoot,
    input.logsDir,
  );

  return {
    scenario: input.scenario,
    cli: {
      exitCode: input.exitCode,
      stdout: normalizeOutput(input.stdout, input.tempRoot, input.logsDir),
      stderr: normalizeOutput(input.stderr, input.tempRoot, input.logsDir),
    },
    run: summarizeRun(checkpoint, input.logsDir, input.tempRoot),
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
    .filter(([key]) => key !== "current_node")
    .filter(([key]) => key !== "graph.goal")
    .filter(([key]) => key !== "last_response")
    .filter(([key]) => isStableContextKey(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(filteredEntries.map(([key, value]) => [key, sortValue(value)]));
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
    const normalized = normalizeJsonFile(path.join(questionsDir, entry), tempRoot, runLogsDir);
    if (!normalized) {
      continue;
    }
    records[entry] = summarizeQuestion(normalized);
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
    .filter((line) => !isTimestampedEventLine(line));
}

function normalizeString(value: string, tempRoot: string, logsDir: string): string {
  return value
    .replaceAll(tempRoot, "<TMP_ROOT>")
    .replaceAll(logsDir, "<LOGS_DIR>")
    .replaceAll(workflowsDir, "<WORKFLOWS_DIR>")
    .replaceAll(repoRoot, "<REPO_ROOT>");
}

function resolvePlaceholders<T>(value: T, tempRoot: string, scenario: string): T {
  if (typeof value === "string") {
    return value
      .replaceAll("<TMP_ROOT>", tempRoot)
      .replaceAll("<WORKFLOWS_DIR>", workflowsDir)
      .replaceAll("<REPO_ROOT>", repoRoot)
      .replaceAll("<SCENARIO>", scenario) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePlaceholders(item, tempRoot, scenario)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        resolvePlaceholders(nested, tempRoot, scenario),
      ]),
    ) as T;
  }
  return value;
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

function summarizeRun(
  checkpoint: Record<string, unknown> | null,
  logsDir: string,
  tempRoot: string,
): GoldenSnapshot["run"] {
  const source = (checkpoint ?? {}) as Record<string, unknown>;
  const context =
    source.context && typeof source.context === "object"
      ? (source.context as Record<string, unknown>)
      : {};
  const nodeOutcomes =
    source.nodeOutcomes && typeof source.nodeOutcomes === "object"
      ? (source.nodeOutcomes as Record<string, unknown>)
      : {};
  const completedNodes = Array.isArray(source.completedNodes)
    ? source.completedNodes.map((value) => String(value))
    : [];
  const currentNode = String(source.currentNode ?? "");
  const outcomeStatus = String(context.outcome ?? "");

  return {
    outcome: {
      status: outcomeStatus,
      failureReason: findFailureReason({
        outcomeStatus,
        currentNode,
        completedNodes,
        nodeOutcomes,
      }),
    },
    currentNode,
    completedNodes,
    waitingForQuestionId: String(source.waitingForQuestionId ?? ""),
    keyContext: context,
    artifacts: {
      nodeStatus: summarizeNodeOutcomes(nodeOutcomes),
      managerLoops: collectManagerLoopArtifacts(logsDir, tempRoot),
      questions: collectQuestionArtifacts(logsDir, tempRoot, logsDir),
    },
  };
}

function summarizeNodeOutcomes(nodeOutcomes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(nodeOutcomes)
      .map(([nodeId, rawOutcome]) => [nodeId, summarizeOutcome(rawOutcome)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeOutcome(rawOutcome: unknown): Record<string, unknown> {
  const outcome = rawOutcome && typeof rawOutcome === "object"
    ? (rawOutcome as Record<string, unknown>)
    : {};
  const summary: Record<string, unknown> = {
    status: String(outcome.status ?? ""),
  };
  if (typeof outcome.failureReason === "string" && outcome.failureReason.length > 0) {
    summary.failureReason = outcome.failureReason;
  }
  if (Array.isArray(outcome.suggestedNextIds) && outcome.suggestedNextIds.length > 0) {
    summary.suggestedNextIds = outcome.suggestedNextIds.map((value) => String(value));
  }
  if (typeof outcome.preferredLabel === "string" && outcome.preferredLabel.length > 0) {
    summary.preferredLabel = outcome.preferredLabel;
  }
  return summary;
}

function collectManagerLoopArtifacts(
  logsDir: string,
  tempRoot: string,
): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {};
  for (const entry of listStageDirectories(logsDir)) {
    const filePath = path.join(logsDir, entry, "manager_loop.json");
    const normalized = normalizeJsonFile(filePath, tempRoot, logsDir);
    if (!normalized) {
      continue;
    }
    artifacts[entry] = summarizeManagerLoop(normalized);
  }
  return sortValue(artifacts) as Record<string, unknown>;
}

function summarizeManagerLoop(rawArtifact: Record<string, unknown>): Record<string, unknown> {
  return sortValue({
    cycleCount: rawArtifact.cycleCount ?? 0,
    finalChildLockDecision: rawArtifact.finalChildLockDecision ?? "",
    finalChildOutcome: rawArtifact.finalChildOutcome ?? "",
    finalChildStatus: rawArtifact.finalChildStatus ?? "",
    finalFailureReason: rawArtifact.finalFailureReason ?? "",
    finalStatus: rawArtifact.finalStatus ?? "",
  }) as Record<string, unknown>;
}

function summarizeQuestion(rawQuestion: Record<string, unknown>): Record<string, unknown> {
  const question =
    rawQuestion.question && typeof rawQuestion.question === "object"
      ? (rawQuestion.question as Record<string, unknown>)
      : {};
  const options = Array.isArray(question.options) ? question.options : [];
  return sortValue({
    answerValue:
      rawQuestion.answer && typeof rawQuestion.answer === "object"
        ? String((rawQuestion.answer as Record<string, unknown>).value ?? "")
        : "",
    options: options.map((option) =>
      option && typeof option === "object"
        ? {
            key: String((option as Record<string, unknown>).key ?? ""),
            label: String((option as Record<string, unknown>).label ?? ""),
          }
        : { key: "", label: "" },
    ),
    stage: String(rawQuestion.stage ?? ""),
    status: String(rawQuestion.status ?? ""),
    text: String(question.text ?? ""),
    type: String(question.type ?? ""),
  }) as Record<string, unknown>;
}

function findFailureReason(input: {
  outcomeStatus: string;
  currentNode: string;
  completedNodes: string[];
  nodeOutcomes: Record<string, unknown>;
}): string {
  if (input.outcomeStatus !== "fail") {
    return "";
  }

  const preferredNodeIds = [
    input.currentNode,
    ...[...input.completedNodes].reverse(),
  ].filter((nodeId, index, all) => nodeId.length > 0 && all.indexOf(nodeId) === index);

  for (const nodeId of preferredNodeIds) {
    const outcome = input.nodeOutcomes[nodeId];
    if (!outcome || typeof outcome !== "object") {
      continue;
    }
    const failureReason = (outcome as Record<string, unknown>).failureReason;
    if (typeof failureReason === "string" && failureReason.length > 0) {
      return failureReason;
    }
  }

  for (const value of Object.values(input.nodeOutcomes)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const failureReason = (value as Record<string, unknown>).failureReason;
    if (typeof failureReason === "string" && failureReason.length > 0) {
      return failureReason;
    }
  }

  return "";
}

function isStableContextKey(key: string): boolean {
  return (
    key === "outcome" ||
    key === "last_stage" ||
    key.startsWith("human.gate.") ||
    key.startsWith("parallel.fan_in.") ||
    key.startsWith("stack.manager_loop.")
  );
}

function isTimestampedEventLine(line: string): boolean {
  return /^\[\d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?\]/u.test(line);
}

function resolvePnpmBinary(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
