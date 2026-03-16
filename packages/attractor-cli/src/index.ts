#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type BackendFactoryOptions,
  type CapableBackend,
  preparePipeline,
  PipelineRunner,
  Severity,
  ConsoleInterviewer,
  AutoApproveInterviewer,
  createServer,
  InMemorySteeringQueue,
  type PipelineEvent,
  type CodergenBackend,
  QuestionStore,
  type HumanPromptAnswerMap,
} from "@attractor/core";
import { createDebugAgentWriter } from "./debug-agent.js";
import { DurableConsoleInterviewer } from "./durable-console-interviewer.js";
import {
  createTestBackend,
  createTestInterviewer,
  loadCliTestConfig,
} from "./test-harness.js";

export interface CliDeps {
  createBackend: (options: BackendFactoryOptions) => CodergenBackend;
}

const defaultDeps: CliDeps = {
  createBackend: () => {
    throw new Error("No backend factory configured for @attractor/cli");
  },
};

export async function main(argv: string[] = process.argv.slice(2), deps: CliDeps = defaultDeps) {
  const args = argv;
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  if (command === "run") {
    await runCommand(args.slice(1), deps);
  } else if (command === "validate") {
    validateCommand(args.slice(1));
  } else if (command === "serve") {
    await serveCommand(args.slice(1), deps);
  } else if (command === "answer") {
    await answerCommand(args.slice(1));
  } else if (command === "steer") {
    await steerCommand(args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
}

export function shouldRunAsCliEntry(
  argv1: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!argv1) return false;

  const entryPath = fs.realpathSync(argv1);
  const modulePath = fs.realpathSync(fileURLToPath(moduleUrl));
  const entryHref = pathToFileURL(entryPath).href;
  return moduleUrl === entryHref || modulePath === entryPath;
}

function printUsage() {
  console.log(`
attractor - DOT-based pipeline runner

Usage:
  attractor run <file.dot> [options]
  attractor validate <file.dot>
  attractor serve [options]
  attractor answer --run <run-id> --prompt <prompt-id> --answers <json>
  attractor steer <run-id> --message <text> [options]

Commands:
  run        Execute a pipeline from a DOT file
  validate   Check a DOT file for errors
  serve      Start HTTP server for web-based pipeline management
  answer     Submit durable human answers for a local run
  steer      Send a steering message to a running pipeline

Options (run):
  --simulate         Run in simulation mode (no LLM calls)
  --auto-approve     Auto-approve all human gates
  --logs-dir <path>  Output directory for logs (default: .attractor-runs/<timestamp>)
  --resume-from <path> Resume from an existing run checkpoint directory
  --provider <name>  LLM provider (default: pi settings, else anthropic)
  --model <id>       LLM model ID (default: pi settings, else claude-sonnet-4-5-20250929)
  --debug-agent      Write redacted agent internals to run logs (system prompt, tools, thread events)
  --set <key=value>  Set a pipeline variable (repeatable)
  --verbose          Show detailed event output

Options (serve):
  --port <number>    Port to listen on (default: 3000)
  --host <addr>      Host to bind to (default: 127.0.0.1)
  --provider <name>  LLM provider for served runs (default: pi settings, else anthropic)
  --model <id>       LLM model ID for served runs (default: pi settings, else claude-sonnet-4-5-20250929)

Options (answer):
  --run <id>         Local run id under .attractor-runs
  --prompt <id>      Durable prompt id to answer
  --answers <json>   Stringified answer map

Options (steer):
  --message <text>   Steering message to inject
  --port <number>    Server port (default: 3000)
  --host <addr>      Server host (default: 127.0.0.1)

General:
  --help, -h         Show this help
`);
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export async function runCommand(args: string[], deps: CliDeps = defaultDeps) {
  // Find DOT file: first positional arg (skip values that follow --flags)
  const flagsWithValues = new Set([
    "--logs-dir",
    "--provider",
    "--model",
    "--resume-from",
    "--set",
  ]);
  let dotFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      if (flagsWithValues.has(args[i]!)) i++; // skip the flag's value
      continue;
    }
    dotFile = args[i];
    break;
  }
  const simulate = args.includes("--simulate");
  const autoApprove = args.includes("--auto-approve");
  const verbose = args.includes("--verbose");
  const debugAgent = args.includes("--debug-agent");

  const logsDir = getArgValue(args, "--logs-dir");
  const resumeFromFlag = getArgValue(args, "--resume-from");
  const provider = getArgValue(args, "--provider");
  const model = getArgValue(args, "--model");

  // Parse --set key=value flags (repeatable)
  const variables: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set" && args[i + 1]) {
      const pair = args[i + 1]!;
      const eqIdx = pair.indexOf("=");
      if (eqIdx >= 0) {
        variables[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
      } else {
        console.error(`Error: --set requires key=value format, got: ${pair}`);
        process.exit(1);
      }
      i++; // skip the value
    }
  }

  if (!dotFile) {
    console.error("Error: No DOT file specified");
    process.exit(1);
  }

  const filePath = path.resolve(dotFile);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const source = fs.readFileSync(filePath, "utf-8");

  // Parse and validate
  let graph;
  try {
    const result = preparePipeline(source, { variables, dotFilePath: filePath });
    graph = result.graph;
    const warnings = result.diagnostics.filter((d) => d.severity === Severity.WARNING);
    for (const w of warnings) {
      console.warn(`  [WARN] [${w.rule}] ${w.message}`);
    }
  } catch (err) {
    console.error(`Validation failed:\n${err}`);
    process.exit(1);
  }

  console.log(`Pipeline: ${graph.id}`);
  console.log(`Goal: ${graph.attrs.goal || "(none)"}`);
  console.log(`Nodes: ${graph.nodes.size}`);
  console.log(`Edges: ${graph.edges.length}`);
  if (simulate) console.log("Mode: simulation");
  console.log("---");

  // Build runner
  const logsRoot = logsDir ?? path.join(process.cwd(), ".attractor-runs", Date.now().toString());
  const runId = path.basename(logsRoot);
  const testConfig = loadCliTestConfig();
  const debugWriter = debugAgent ? createDebugAgentWriter(logsRoot) : null;
  const interviewer =
    createTestInterviewer(testConfig, logsRoot, runId) ??
    (autoApprove
      ? new AutoApproveInterviewer()
      : createCliInterviewer(runId, logsRoot));
  const resumeFrom = resumeFromFlag ?? testConfig?.resumeFrom;
  const testBackend = createTestBackend(testConfig);

  let backend: CodergenBackend | null;
  const steeringQueue = new InMemorySteeringQueue();
  if (testBackend) {
    backend = testBackend;
  } else if (simulate) {
    backend = null;
  } else {
    backend = deps.createBackend({
      cwd: path.dirname(filePath),
      steeringQueue,
      ...(provider && { provider }),
      ...(model && { model }),
      ...(debugWriter ? { debugSink: debugWriter } : {}),
      warningSink: (message: string) => {
        console.warn(`[WARN] ${message}`);
      },
    });
  }
  warnIfDebugUnsupported(backend, debugAgent);

  const runner = new PipelineRunner({
    backend,
    interviewer,
    logsRoot,
    ...(resumeFrom ? { resumeFrom } : {}),
    runId,
    steeringQueue,
    onEvent: (event) => {
      printEvent(event, verbose);
    },
  });

  try {
    const result = await runner.run(graph);
    console.log("\n---");
    console.log(`Result: ${result.outcome.status}`);
    console.log(`Completed: ${result.completedNodes.join(" -> ")}`);
    console.log(`Logs: ${logsRoot}`);

    if (result.outcome.status === "fail") {
      console.error(`Failure: ${result.outcome.failureReason}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Pipeline execution error: ${err}`);
    process.exit(1);
  } finally {
    if (
      backend &&
      "dispose" in backend &&
      typeof (backend as { dispose?: unknown }).dispose === "function"
    ) {
      await (backend as { dispose: () => Promise<void> }).dispose();
    }
  }
}

function validateCommand(args: string[]) {
  const dotFile = args.find((a) => !a.startsWith("--"));
  if (!dotFile) {
    console.error("Error: No DOT file specified");
    process.exit(1);
  }

  const filePath = path.resolve(dotFile);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const source = fs.readFileSync(filePath, "utf-8");

  try {
    const result = preparePipeline(source, { dotFilePath: filePath });
    const errors = result.diagnostics.filter((d) => d.severity === Severity.ERROR);
    const warnings = result.diagnostics.filter((d) => d.severity === Severity.WARNING);

    if (errors.length > 0) {
      console.error("ERRORS:");
      for (const e of errors) {
        console.error(`  [${e.rule}] ${e.message}`);
      }
    }
    if (warnings.length > 0) {
      console.warn("WARNINGS:");
      for (const w of warnings) {
        console.warn(`  [${w.rule}] ${w.message}`);
      }
    }

    if (errors.length === 0) {
      console.log(`Valid pipeline: ${result.graph.id} (${result.graph.nodes.size} nodes, ${result.graph.edges.length} edges)`);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Validation failed: ${err}`);
    process.exit(1);
  }
}

export async function serveCommand(args: string[], deps: CliDeps = defaultDeps) {
  const port = Number(getArgValue(args, "--port") ?? "3000");
  const host = getArgValue(args, "--host") ?? "127.0.0.1";
  const provider = getArgValue(args, "--provider");
  const model = getArgValue(args, "--model");
  const steeringQueue = new InMemorySteeringQueue();

  const backend = deps.createBackend({
    cwd: process.cwd(),
    steeringQueue,
    ...(provider && { provider }),
    ...(model && { model }),
  });

  const server = createServer({
    backend,
    steeringQueue,
  });

  server.listen(port, host, () => {
    console.log(`Attractor HTTP server listening on http://${host}:${port}`);
    console.log("Endpoints:");
    console.log("  POST /pipelines              - Start a pipeline (JSON body: { dotSource })");
    console.log("  GET  /pipelines/:id          - Get run status");
    console.log("  POST /pipelines/:id/steer    - Queue manager steering");
    console.log("  POST /pipelines/:id/questions/:qid/answer - Submit human answer");
    console.log("  GET  /pipelines/:id/events   - SSE event stream");
  });

  // Keep the process alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      server.close(async () => {
        if ("dispose" in backend && typeof (backend as { dispose?: unknown }).dispose === "function") {
          await (backend as { dispose: () => Promise<void> }).dispose();
        }
        resolve();
      });
    });
    process.on("SIGTERM", () => {
      console.log("\nShutting down...");
      server.close(async () => {
        if ("dispose" in backend && typeof (backend as { dispose?: unknown }).dispose === "function") {
          await (backend as { dispose: () => Promise<void> }).dispose();
        }
        resolve();
      });
    });
  });
}

export async function answerCommand(args: string[]) {
  const runId = getArgValue(args, "--run");
  const promptId = getArgValue(args, "--prompt");
  const answersRaw = getArgValue(args, "--answers");

  if (!runId) {
    console.error("Error: --run is required");
    process.exit(1);
  }
  if (!promptId) {
    console.error("Error: --prompt is required");
    process.exit(1);
  }
  if (!answersRaw) {
    console.error("Error: --answers is required");
    process.exit(1);
  }

  let answers: HumanPromptAnswerMap;
  try {
    answers = JSON.parse(answersRaw) as HumanPromptAnswerMap;
  } catch (error) {
    console.error(`Error: --answers must be valid JSON: ${String(error)}`);
    process.exit(1);
  }

  const logsRoot = path.join(process.cwd(), ".attractor-runs", runId);
  if (!fs.existsSync(logsRoot)) {
    console.error(`Error: run not found: ${logsRoot}`);
    process.exit(1);
  }

  const store = new QuestionStore(logsRoot);
  const submit = store.submitAnswers(runId, promptId, answers);
  if (!submit.ok) {
    if (submit.reason === "not_found") {
      console.error(`Unknown prompt: ${promptId}`);
      process.exit(1);
    }
    if (submit.reason === "run_mismatch") {
      console.error(`Prompt ${promptId} does not belong to run ${runId}`);
      process.exit(1);
    }
    if (submit.reason === "already_answered") {
      console.error(`Prompt ${promptId} was already answered`);
      process.exit(1);
    }
    if (submit.reason === "invalid_answers") {
      console.error(submit.message ?? `Prompt ${promptId} answers are invalid`);
      process.exit(1);
    }
    console.error(`Prompt ${promptId} is not pending`);
    process.exit(1);
  }

  console.log(`Stored answers for ${promptId}`);
}

export async function steerCommand(args: string[]) {
  const runId = args.find((arg) => !arg.startsWith("--"));
  const message = getArgValue(args, "--message");
  const port = Number(getArgValue(args, "--port") ?? "3000");
  const host = getArgValue(args, "--host") ?? "127.0.0.1";

  if (!runId) {
    console.error("Error: No run ID specified");
    process.exit(1);
  }
  if (!message) {
    console.error("Error: --message is required");
    process.exit(1);
  }

  const response = await fetch(`http://${host}:${port}/pipelines/${runId}/steer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    console.error(String(data.error ?? `HTTP ${response.status}`));
    process.exit(1);
  }

  console.log(`Steering queued for ${runId}`);
}

function warnIfDebugUnsupported(
  backend: CodergenBackend | null,
  debugAgent: boolean,
): void {
  if (!debugAgent || !backend) {
    return;
  }
  const capabilities = (backend as CapableBackend).getCapabilities?.();
  if (capabilities?.debugTelemetry === false) {
    console.warn("[WARN] Backend does not support debug telemetry; skipping debug artifacts");
  }
}

function createCliInterviewer(runId: string, logsRoot: string) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return new ConsoleInterviewer();
  }
  return new DurableConsoleInterviewer(runId, logsRoot);
}

function printEvent(event: PipelineEvent, verbose: boolean) {
  const ts = new Date().toLocaleTimeString();
  switch (event.type) {
    case "pipeline_started":
      console.log(`[${ts}] Pipeline started: ${event.name}`);
      break;
    case "pipeline_completed":
      console.log(`[${ts}] Pipeline completed in ${event.durationMs}ms`);
      break;
    case "pipeline_failed":
      console.error(`[${ts}] Pipeline failed: ${event.error}`);
      break;
    case "stage_started":
      console.log(`[${ts}] Stage ${event.index}: ${event.name}`);
      break;
    case "stage_completed":
      if (verbose) console.log(`[${ts}]   completed (${event.durationMs}ms)`);
      break;
    case "stage_retrying":
      console.log(
        `[${ts}]   retrying (attempt ${event.attempt}, delay ${event.delayMs}ms)`,
      );
      break;
    case "stage_failed":
      console.error(`[${ts}]   failed: ${event.error}`);
      break;
    case "checkpoint_saved":
      if (verbose) console.log(`[${ts}]   checkpoint saved`);
      break;
    case "interview_started":
      console.log(`[${ts}] Human gate: ${event.question}`);
      break;
    default:
      if (verbose) console.log(`[${ts}] ${event.type}`);
  }
}

if (shouldRunAsCliEntry()) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
