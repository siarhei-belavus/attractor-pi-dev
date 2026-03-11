import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { preparePipeline } from "../engine/pipeline.js";
import { PipelineRunner } from "../engine/runner.js";
import type { RunConfig, RunResult } from "../engine/runner.js";
import type { PipelineEvent, EventListener } from "../events/index.js";
import type {
  Answer,
  CodergenBackend,
  ManagerObserverFactory,
} from "../handlers/types.js";
import { StageStatus } from "../state/types.js";
import { Checkpoint } from "../state/checkpoint.js";
import type { Graph } from "../model/graph.js";
import { DurableInterviewer } from "./durable-interviewer.js";
import { QuestionStore } from "./question-store.js";
import type { QuestionRecord } from "./question-store.js";
import { RunStateStore } from "./run-state.js";
import type { RunStatus } from "./run-state.js";
import {
  createSteeringMessage,
  InMemorySteeringQueue,
  type SteeringQueue,
  type SteeringTarget,
} from "../steering/queue.js";

export type { RunStatus } from "./run-state.js";

export interface RunState {
  runId: string;
  status: RunStatus;
  graph: Graph | null;
  dotSource: string;
  logsRoot: string;
  runner: PipelineRunner | null;
  result: RunResult | null;
  error: string | null;
  completedNodes: string[];
  currentNode: string | null;
  context: Record<string, unknown>;
  events: PipelineEvent[];
  eventListeners: Set<EventListener>;
  pendingQuestionId: string | null;
  activeManagerTarget: SteeringTarget | null;
  cancelled: boolean;
  runStateStore: RunStateStore;
  questionStore: QuestionStore;
}

export interface ServerConfig {
  backend?: CodergenBackend | null;
  managerObserverFactory?: ManagerObserverFactory;
  steeringQueue?: SteeringQueue;
  logsRoot?: string;
}

export function createServer(serverConfig: ServerConfig = {}): http.Server {
  const runs = new Map<string, RunState>();
  const steeringQueue = serverConfig.steeringQueue ?? new InMemorySteeringQueue();
  const runsBaseRoot =
    serverConfig.logsRoot ??
    path.join(process.cwd(), ".attractor-runs");
  fs.mkdirSync(runsBaseRoot, { recursive: true });
  let nextRunId = 1;

  function generateRunId(): string {
    while (runs.has(`run-${nextRunId}`)) {
      nextRunId++;
    }
    const runId = `run-${nextRunId}`;
    nextRunId++;
    return runId;
  }

  function sendJson(
    res: http.ServerResponse,
    statusCode: number,
    data: unknown,
  ): void {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendError(
    res: http.ServerResponse,
    statusCode: number,
    message: string,
  ): void {
    sendJson(res, statusCode, { error: message });
  }

  function parsePath(url: string): string[] {
    const pathname = new URL(url, "http://localhost").pathname;
    return pathname.split("/").filter(Boolean);
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  function hydrateFromRunState(run: RunState): void {
    const durable = run.runStateStore.load();
    if (!durable) {
      return;
    }
    run.status = durable.status;
    run.currentNode = durable.currentNode;
    run.completedNodes = [...durable.completedNodes];
    run.pendingQuestionId = durable.pendingQuestionId;
    run.error = durable.error ?? run.error;

    if (!run.result && Checkpoint.exists(run.logsRoot)) {
      try {
        const checkpoint = Checkpoint.load(run.logsRoot);
        run.context = checkpoint.contextValues;
      } catch {
        // Keep previous in-memory context when checkpoint is malformed.
      }
    }
  }

  function persistRunState(run: RunState): void {
    run.runStateStore.save({
      runId: run.runId,
      status: run.status,
      currentNode: run.currentNode,
      completedNodes: [...run.completedNodes],
      pendingQuestionId: run.pendingQuestionId,
      updatedAt: new Date().toISOString(),
      ...(run.error ? { error: run.error } : {}),
    });
  }

  function resolvePendingQuestion(run: RunState): QuestionRecord | null {
    if (run.pendingQuestionId) {
      const direct = run.questionStore.get(run.pendingQuestionId);
      if (direct && direct.status === "pending") {
        return direct;
      }
    }
    const pending = run.questionStore.listPending(run.runId);
    if (pending.length === 0) {
      return null;
    }
    const newest = pending.sort((left, right) =>
      right.id.localeCompare(left.id),
    )[0];
    return newest ?? null;
  }

  function createRunState(
    runId: string,
    logsRoot: string,
    dotSource: string,
    graph: Graph | null,
    initialStatus: RunStatus,
  ): RunState {
    const runStateStore = new RunStateStore(logsRoot);
    const questionStore = new QuestionStore(logsRoot);
    return {
      runId,
      status: initialStatus,
      graph,
      dotSource,
      logsRoot,
      runner: null,
      result: null,
      error: null,
      completedNodes: [],
      currentNode: null,
      context: {},
      events: [],
      eventListeners: new Set(),
      pendingQuestionId: null,
      activeManagerTarget: null,
      cancelled: initialStatus === "cancelled",
      runStateStore,
      questionStore,
    };
  }

  function emitEvent(run: RunState, event: PipelineEvent): void {
    run.events.push(event);
    for (const listener of run.eventListeners) {
      listener(event);
    }
  }

  function startRunner(run: RunState, resumeFrom?: string): void {
    if (!run.graph) {
      run.status = "failed";
      run.error = "Run graph is unavailable";
      persistRunState(run);
      return;
    }

    const interviewer = new DurableInterviewer(run.runId, run.questionStore, {
      onWaiting: (question) => {
        run.status = "waiting_for_answer";
        run.pendingQuestionId = question.id;
        persistRunState(run);
      },
    });

    const runConfig: RunConfig = {
      backend: serverConfig.backend ?? null,
      interviewer,
      logsRoot: run.logsRoot,
      runId: run.runId,
      steeringQueue,
      ...(serverConfig.managerObserverFactory
        ? {
            managerObserverFactory: async (input) => {
              const executionId =
                input.context.getString("internal.last_completed_execution_id") || "";
              const branchKey =
                input.context.getString("internal.last_completed_branch_key") || "";
              const nodeId =
                input.context.getString("internal.last_completed_node_id") || "";
              run.activeManagerTarget = {
                runId: run.runId,
                ...(executionId ? { executionId } : {}),
                ...(branchKey ? { branchKey } : {}),
                ...(nodeId ? { nodeId } : {}),
              };
              return serverConfig.managerObserverFactory!(input);
            },
          }
        : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
      onEvent: (event: PipelineEvent) => {
        if (event.type === "stage_started") {
          run.currentNode = event.name;
          run.activeManagerTarget = null;
          if (!run.cancelled && run.status !== "waiting_for_answer") {
            run.status = "running";
          }
          persistRunState(run);
        }
        if (event.type === "stage_completed") {
          if (!run.completedNodes.includes(event.name)) {
            run.completedNodes.push(event.name);
          }
          persistRunState(run);
        }
        emitEvent(run, event);
      },
    };

    const runner = new PipelineRunner(runConfig);
    run.runner = runner;

    runner
      .run(run.graph)
      .then((result: RunResult) => {
        if (run.cancelled) {
          return;
        }
        run.result = result;
        if (result.outcome.status === StageStatus.WAITING) {
          run.status = "waiting_for_answer";
          run.pendingQuestionId =
            result.context.getString("internal.waiting_for_question_id") || null;
        } else {
          run.status = result.outcome.status === StageStatus.FAIL ? "failed" : "completed";
          run.pendingQuestionId = null;
        }
        run.activeManagerTarget = null;
        run.completedNodes = [...result.completedNodes];
        if (result.outcome.status !== StageStatus.WAITING) {
          run.currentNode = run.completedNodes[run.completedNodes.length - 1] ?? null;
        }
        run.context = result.context.snapshot();
        run.error = null;
        persistRunState(run);
      })
      .catch((err: unknown) => {
        if (run.cancelled) {
          return;
        }
        run.status = "failed";
        run.error = String(err);
        run.pendingQuestionId = null;
        run.activeManagerTarget = null;
        persistRunState(run);
      });
  }

  function recoverRunsFromDisk(): void {
    const entries = fs.readdirSync(runsBaseRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const runId = entry.name;
        const logsRoot = path.join(runsBaseRoot, runId);
        const runStateStore = new RunStateStore(logsRoot);
        const durable = runStateStore.load();
        if (!durable) {
          continue;
        }

        const runMatch = /^run-(\d+)$/.exec(runId);
        if (runMatch) {
          const runNum = Number(runMatch[1]);
          if (Number.isFinite(runNum)) {
            nextRunId = Math.max(nextRunId, runNum + 1);
          }
        }

        const dotPath = path.join(logsRoot, "pipeline.dot");
        const dotSource = fs.existsSync(dotPath)
          ? fs.readFileSync(dotPath, "utf-8")
          : "";

        let graph: Graph | null = null;
        if (dotSource) {
          try {
            graph = preparePipeline(dotSource).graph;
          } catch {
            graph = null;
          }
        }

        const run = createRunState(runId, logsRoot, dotSource, graph, durable.status);
        run.currentNode = durable.currentNode;
        run.completedNodes = [...durable.completedNodes];
        run.pendingQuestionId = durable.pendingQuestionId;
        run.error = durable.error ?? null;
        run.cancelled = durable.status === "cancelled";
        if (Checkpoint.exists(logsRoot)) {
          try {
            run.context = Checkpoint.load(logsRoot).contextValues;
          } catch {
            // Skip broken checkpoint context; run metadata is still recoverable.
          }
        }
        runs.set(runId, run);
      } catch {
        // Ignore malformed run directories to keep startup/recovery available.
      }
    }

    for (const run of runs.values()) {
      if (run.status === "running") {
        startRunner(run, run.logsRoot);
      }
    }
  }

  recoverRunsFromDisk();

  async function handlePostPipelines(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, "Failed to read request body");
      return;
    }

    let parsed: { dotSource?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendError(res, 400, "Invalid JSON");
      return;
    }

    if (!parsed.dotSource || typeof parsed.dotSource !== "string") {
      sendError(res, 400, "Missing or invalid dotSource");
      return;
    }

    let graph: Graph;
    try {
      graph = preparePipeline(parsed.dotSource).graph;
    } catch (err) {
      sendError(res, 400, `Invalid DOT source: ${err}`);
      return;
    }

    const runId = generateRunId();
    const logsRoot = path.join(runsBaseRoot, runId);
    fs.mkdirSync(logsRoot, { recursive: true });
    fs.writeFileSync(path.join(logsRoot, "pipeline.dot"), parsed.dotSource);

    const run = createRunState(runId, logsRoot, parsed.dotSource, graph, "running");
    runs.set(runId, run);
    persistRunState(run);
    startRunner(run);

    sendJson(res, 201, { runId });
  }

  function handleGetStatus(res: http.ServerResponse, runId: string): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    hydrateFromRunState(run);
    const pendingQuestion = resolvePendingQuestion(run);

    const response: Record<string, unknown> = {
      runId: run.runId,
      status: run.status,
      currentNode: run.currentNode,
      completedNodes: run.completedNodes,
      context: run.context,
    };

    if (pendingQuestion) {
      response.pendingQuestion = {
        id: pendingQuestion.id,
        status: pendingQuestion.status,
        text: pendingQuestion.question.text,
        type: pendingQuestion.question.type,
        options: pendingQuestion.question.options,
        stage: pendingQuestion.stage,
        createdAt: pendingQuestion.createdAt,
      };
    }

    if (run.result) {
      response.outcome = run.result.outcome;
      response.context = run.result.context.snapshot();
    }

    if (run.error) {
      response.error = run.error;
    }

    sendJson(res, 200, response);
  }

  function handlePostCancel(res: http.ServerResponse, runId: string): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    hydrateFromRunState(run);
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      sendError(res, 409, `Pipeline is already ${run.status}`);
      return;
    }

    run.cancelled = true;
    run.status = "cancelled";
    run.error = "Pipeline cancelled by user";
    if (run.pendingQuestionId) {
      run.questionStore.markCancelled(run.runId, run.pendingQuestionId);
    }
    run.pendingQuestionId = null;
    persistRunState(run);

    sendJson(res, 200, { runId, status: "cancelled" });
  }

  async function handlePostAnswer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runId: string,
    questionId: string,
  ): Promise<void> {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, "Failed to read request body");
      return;
    }

    let parsed: { value?: string; text?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendError(res, 400, "Invalid JSON");
      return;
    }

    if (parsed.value === undefined) {
      sendError(res, 400, "Missing answer value");
      return;
    }

    hydrateFromRunState(run);
    const pendingQuestion = resolvePendingQuestion(run);
    if (!pendingQuestion) {
      sendError(res, 409, "No pending question for this run");
      return;
    }
    if (pendingQuestion.id !== questionId) {
      sendError(
        res,
        409,
        `Question ${questionId} is stale; pending question is ${pendingQuestion.id}`,
      );
      return;
    }

    const answer: Answer = {
      value: parsed.value,
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      questionId,
    };
    const submit = run.questionStore.submitAnswer(runId, questionId, answer);
    if (!submit.ok) {
      if (submit.reason === "not_found") {
        sendError(res, 404, `Unknown questionId: ${questionId}`);
        return;
      }
      if (submit.reason === "already_answered") {
        sendError(res, 409, `Question ${questionId} was already answered`);
        return;
      }
      if (submit.reason === "run_mismatch") {
        sendError(res, 409, `Question ${questionId} does not belong to run ${runId}`);
        return;
      }
      sendError(res, 409, `Question ${questionId} is not pending`);
      return;
    }

    if (!run.cancelled) {
      run.status = "running";
      run.pendingQuestionId = null;
      run.error = null;
      run.result = null;
      persistRunState(run);
      startRunner(run, run.logsRoot);
    }

    sendJson(res, 200, { accepted: true, questionId });
  }

  async function handlePostSteer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runId: string,
  ): Promise<void> {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, "Failed to read request body");
      return;
    }

    let parsed: { message?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendError(res, 400, "Invalid JSON");
      return;
    }

    if (!parsed.message || typeof parsed.message !== "string") {
      sendError(res, 400, "Missing or invalid message");
      return;
    }

    hydrateFromRunState(run);
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      sendError(res, 409, `Pipeline is already ${run.status}`);
      return;
    }
    if (!run.activeManagerTarget) {
      sendError(res, 409, "Run has no active manager steering target");
      return;
    }

    const target = run.activeManagerTarget;
    steeringQueue.enqueue(
      createSteeringMessage({
        target,
        message: parsed.message,
        source: "api",
      }),
    );

    sendJson(res, 200, {
      accepted: true,
      runId,
      target,
      delivery: "queued",
    });
  }

  function handleGetEvents(res: http.ServerResponse, runId: string): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    for (const event of run.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const listener: EventListener = (event: PipelineEvent) => {
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    run.eventListeners.add(listener);

    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
      res.end();
      return;
    }

    res.on("close", () => {
      run.eventListeners.delete(listener);
    });
  }

  function handleGetCheckpoint(res: http.ServerResponse, runId: string): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    hydrateFromRunState(run);
    const pendingQuestion = resolvePendingQuestion(run);
    if (Checkpoint.exists(run.logsRoot)) {
      let cp: Checkpoint;
      try {
        cp = Checkpoint.load(run.logsRoot);
      } catch (err) {
        sendError(res, 500, `Failed to load checkpoint: ${String(err)}`);
        return;
      }
      sendJson(res, 200, {
        runId: run.runId,
        status: run.status,
        timestamp: cp.timestamp,
        currentNode: cp.currentNode,
        completedNodes: cp.completedNodes,
        nodeRetries: cp.nodeRetries,
        context: cp.contextValues,
        logs: cp.logs,
        nodeOutcomes: cp.nodeOutcomes,
        waitingForQuestionId: pendingQuestion?.id ?? cp.waitingForQuestionId ?? null,
      });
      return;
    }

    sendJson(res, 200, {
      runId: run.runId,
      status: run.status,
      currentNode: run.currentNode,
      completedNodes: run.completedNodes,
      waitingForQuestionId: pendingQuestion?.id ?? null,
    });
  }

  function handleGetContext(res: http.ServerResponse, runId: string): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    if (run.result) {
      sendJson(res, 200, {
        runId: run.runId,
        context: run.result.context.snapshot(),
      });
      return;
    }

    if (Checkpoint.exists(run.logsRoot)) {
      let cp: Checkpoint;
      try {
        cp = Checkpoint.load(run.logsRoot);
      } catch (err) {
        sendError(res, 500, `Failed to load checkpoint context: ${String(err)}`);
        return;
      }
      sendJson(res, 200, { runId: run.runId, context: cp.contextValues });
      return;
    }

    sendJson(res, 200, { runId: run.runId, context: run.context });
  }

  function handleGetGraph(res: http.ServerResponse, runId: string): void {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, `Unknown runId: ${runId}`);
      return;
    }

    const dotSource = run.dotSource;
    if (!dotSource) {
      sendError(res, 404, `DOT source is unavailable for run ${runId}`);
      return;
    }

    try {
      const proc = spawn("dot", ["-Tsvg"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });

      const chunks: Buffer[] = [];
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

      proc.on("error", () => {
        if (!res.headersSent) {
          const body = dotSource;
          res.writeHead(200, {
            "Content-Type": "text/vnd.graphviz",
            "Content-Length": Buffer.byteLength(body),
          });
          res.end(body);
        }
      });

      proc.on("close", (code) => {
        if (res.headersSent) {
          return;
        }
        if (code !== 0) {
          const body = dotSource;
          res.writeHead(200, {
            "Content-Type": "text/vnd.graphviz",
            "Content-Length": Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
        const svg = Buffer.concat(chunks).toString("utf-8");
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": Buffer.byteLength(svg),
        });
        res.end(svg);
      });

      proc.stdin.write(dotSource);
      proc.stdin.end();
    } catch {
      if (!res.headersSent) {
        const body = dotSource;
        res.writeHead(200, {
          "Content-Type": "text/vnd.graphviz",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      }
    }
  }

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method?.toUpperCase() ?? "GET";
    const segments = parsePath(req.url ?? "/");

    try {
      if (segments[0] !== "pipelines") {
        sendError(res, 404, "Not found");
        return;
      }

      if (method === "POST" && segments.length === 1) {
        await handlePostPipelines(req, res);
        return;
      }

      if (segments.length >= 2) {
        const runId = segments[1]!;

        if (method === "GET" && segments.length === 2) {
          handleGetStatus(res, runId);
          return;
        }

        if (
          method === "POST" &&
          segments.length === 3 &&
          segments[2] === "cancel"
        ) {
          handlePostCancel(res, runId);
          return;
        }

        if (
          method === "POST" &&
          segments.length === 3 &&
          segments[2] === "steer"
        ) {
          await handlePostSteer(req, res, runId);
          return;
        }

        if (
          method === "GET" &&
          segments.length === 3 &&
          segments[2] === "events"
        ) {
          handleGetEvents(res, runId);
          return;
        }

        if (
          method === "GET" &&
          segments.length === 3 &&
          segments[2] === "graph"
        ) {
          handleGetGraph(res, runId);
          return;
        }

        if (
          method === "GET" &&
          segments.length === 3 &&
          segments[2] === "checkpoint"
        ) {
          handleGetCheckpoint(res, runId);
          return;
        }

        if (
          method === "GET" &&
          segments.length === 3 &&
          segments[2] === "context"
        ) {
          handleGetContext(res, runId);
          return;
        }

        if (
          method === "POST" &&
          segments.length === 5 &&
          segments[2] === "questions" &&
          segments[4] === "answer"
        ) {
          await handlePostAnswer(req, res, runId, segments[3]!);
          return;
        }
      }

      sendError(res, 404, "Not found");
    } catch (err) {
      sendError(res, 500, `Internal server error: ${err}`);
    }
  }

  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          sendError(res, 500, `Internal server error: ${err}`);
        }
      });
    },
  );

  (server as HttpPipelineServer).runs = runs;

  return server;
}

export interface HttpPipelineServer extends http.Server {
  runs: Map<string, RunState>;
}
