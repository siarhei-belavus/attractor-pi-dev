import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type HttpPipelineServer, type ServerConfig } from "../src/server/index.js";
import { InMemorySteeringQueue } from "../src/steering/queue.js";

/** Simple pipeline DOT source for testing */
const SIMPLE_DOT = `
  digraph Simple {
    graph [goal="Run tests"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    run_tests [label="Run Tests", prompt="Run tests"]
    report    [label="Report", prompt="Summarize"]
    start -> run_tests -> report -> exit
  }
`;

/** Pipeline with a human gate (hexagon shape) */
const HUMAN_GATE_DOT = `
  digraph HumanGate {
    graph [goal="Review pipeline"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    review [shape=hexagon, label="Review Changes"]
    ship_it [label="Ship It", prompt="Deploy"]
    start -> review
    review -> ship_it [label="[A] Approve"]
    ship_it -> exit
  }
`;

const MANAGER_LOOP_DOT = `
  digraph ManagerLoop {
    graph [goal="Observe child", default_fidelity="full"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    child [label="Child", prompt="Do child work", thread_id="child-thread"]
    manager [shape=house, label="Manager"]
    start -> child -> manager -> exit
  }
`;

const INVALID_DOT = "this is not valid DOT syntax {{{";

let server: HttpPipelineServer;
let baseUrl: string;
let tmpLogsRoot: string;

/** Make an HTTP request and return parsed JSON response */
function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          ...(bodyStr && {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
          }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(text);
          } catch {
            data = { _raw: text };
          }
          resolve({ statusCode: res.statusCode ?? 500, data });
        });
      },
    );

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Make an HTTP request and return raw response with content-type */
function requestRaw(
  method: string,
  path: string,
): Promise<{ statusCode: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({
            statusCode: res.statusCode ?? 500,
            contentType: res.headers["content-type"] ?? "",
            body,
          });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

/** Collect SSE events from a stream for a limited time */
function collectSSEEvents(
  path: string,
  maxMs: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const events: Array<Record<string, unknown>> = [];
    let buffer = "";

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          // Parse SSE lines
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const block of lines) {
            for (const line of block.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  events.push(JSON.parse(line.slice(6)));
                } catch {
                  // skip non-JSON data lines
                }
              }
            }
          }
        });
        res.on("end", () => resolve(events));
      },
    );

    req.on("error", reject);
    req.end();

    // Time-limit the stream
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, maxMs);
  });
}

/** Wait for a run to reach a specific status */
async function waitForStatus(
  runId: string,
  targetStatuses: string[],
  maxMs = 5000,
  intervalMs = 50,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { data } = await request("GET", `/pipelines/${runId}`);
    if (targetStatuses.includes(data.status as string)) {
      return data;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for run ${runId} to reach status ${targetStatuses.join("|")}`,
  );
}

async function restartServer(config: ServerConfig = {}): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  server = createServer({ logsRoot: tmpLogsRoot, ...config }) as HttpPipelineServer;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
}

async function waitForPendingQuestion(
  runId: string,
  maxMs = 5000,
): Promise<{ id: string; stage: string }> {
  const status = await waitForStatus(runId, ["waiting_for_answer"], maxMs);
  const pending = status.pendingQuestion as
    | { id?: string; stage?: string }
    | undefined;
  if (!pending?.id || !pending?.stage) {
    throw new Error(`Run ${runId} is waiting but has no pendingQuestion`);
  }
  return { id: pending.id, stage: pending.stage };
}

function listTmpFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.name.endsWith(".tmp")) {
        found.push(fullPath);
      }
    }
  }
  return found;
}

beforeEach(async () => {
  tmpLogsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
  server = createServer({ logsRoot: tmpLogsRoot }) as HttpPipelineServer;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  fs.rmSync(tmpLogsRoot, { recursive: true, force: true });
});

describe("HTTP Server: POST /pipelines", () => {
  it("starts a pipeline and returns a runId", async () => {
    const { statusCode, data } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });

    expect(statusCode).toBe(201);
    expect(data.runId).toBeDefined();
    expect(typeof data.runId).toBe("string");
  });

  it("rejects missing dotSource", async () => {
    const { statusCode, data } = await request("POST", "/pipelines", {});
    expect(statusCode).toBe(400);
    expect(data.error).toContain("Missing or invalid dotSource");
  });

  it("rejects invalid JSON body", async () => {
    const { statusCode, data } = await new Promise((resolve, reject) => {
      const url = new URL("/pipelines", baseUrl);
      const bodyStr = "not json at all";
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 500,
              data: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });

    expect(statusCode).toBe(400);
    expect(data.error).toContain("Invalid JSON");
  });

  it("rejects invalid DOT source", async () => {
    const { statusCode, data } = await request("POST", "/pipelines", {
      dotSource: INVALID_DOT,
    });

    expect(statusCode).toBe(400);
    expect(data.error).toMatch(/Invalid DOT source/i);
  });
});

describe("HTTP Server: GET /pipelines/{id}", () => {
  it("returns run status for a valid runId", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    // Wait for completion (simulation mode is fast)
    const status = await waitForStatus(runId, ["completed"]);

    expect(status.runId).toBe(runId);
    expect(status.status).toBe("completed");
    expect(Array.isArray(status.completedNodes)).toBe(true);
    expect((status.completedNodes as string[]).length).toBeGreaterThan(0);
    expect(status.outcome).toBeDefined();
  });

  it("returns 404 for unknown runId", async () => {
    const { statusCode, data } = await request("GET", "/pipelines/nonexistent");
    expect(statusCode).toBe(404);
    expect(data.error).toContain("Unknown runId");
  });

  it("shows running status immediately after POST /pipelines", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    // Status should be running or already completed (simulation is fast)
    const { statusCode, data } = await request("GET", `/pipelines/${runId}`);
    expect(statusCode).toBe(200);
    expect(["running", "completed"]).toContain(data.status);
  });
});

describe("HTTP Server: POST /pipelines/{id}/questions/{qid}/answer", () => {
  it("returns 404 for unknown runId", async () => {
    const { statusCode, data } = await request(
      "POST",
      "/pipelines/nonexistent/questions/q1/answer",
      { value: "yes" },
    );
    expect(statusCode).toBe(404);
    expect(data.error).toContain("Unknown runId");
  });

  it("returns 409 when there is no pending question", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    // Wait for the pipeline to finish (no human gates in SIMPLE_DOT)
    await waitForStatus(runId, ["completed"]);

    const { statusCode, data } = await request(
      "POST",
      `/pipelines/${runId}/questions/q1/answer`,
      { value: "yes" },
    );
    expect(statusCode).toBe(409);
    expect(data.error).toContain("No pending question");
  });

  it("persists pending question and run-state on disk", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pending = await waitForPendingQuestion(runId);

    const questionPath = path.join(
      tmpLogsRoot,
      runId,
      "questions",
      `${pending.id}.json`,
    );
    expect(fs.existsSync(questionPath)).toBe(true);
    const question = JSON.parse(fs.readFileSync(questionPath, "utf-8")) as {
      status: string;
      stage: string;
    };
    expect(question.status).toBe("pending");
    expect(question.stage).toBe("review");

    const runStatePath = path.join(tmpLogsRoot, runId, "run-state.json");
    expect(fs.existsSync(runStatePath)).toBe(true);
    const runState = JSON.parse(fs.readFileSync(runStatePath, "utf-8")) as {
      status: string;
      pendingQuestionId?: string | null;
    };
    expect(runState.status).toBe("waiting_for_answer");
    expect(runState.pendingQuestionId).toBe(pending.id);

    await request("POST", `/pipelines/${runId}/questions/${pending.id}/answer`, {
      value: "A",
    });
    await waitForStatus(runId, ["completed", "failed"]);
  });

  it("delivers answer for the correct qid and resumes pipeline", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pending = await waitForPendingQuestion(runId);

    const { statusCode, data } = await request(
      "POST",
      `/pipelines/${runId}/questions/${pending.id}/answer`,
      { value: "A" },
    );
    expect(statusCode).toBe(200);
    expect(data.accepted).toBe(true);

    const finalStatus = await waitForStatus(runId, ["completed", "failed"]);
    expect(finalStatus.status).toBe("completed");
  });

  it("rejects wrong qid", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pending = await waitForPendingQuestion(runId);

    const wrongQuestionId =
      pending.id === "q-0001" ? "q-9999" : "q-0001";
    const wrong = await request(
      "POST",
      `/pipelines/${runId}/questions/${wrongQuestionId}/answer`,
      { value: "A" },
    );
    expect(wrong.statusCode).toBe(409);
    expect(wrong.data.error).toContain("stale");

    await request("POST", `/pipelines/${runId}/questions/${pending.id}/answer`, {
      value: "A",
    });
    await waitForStatus(runId, ["completed", "failed"]);
  });

  it("rejects duplicate answer submit for the same qid", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pending = await waitForPendingQuestion(runId);

    const first = await request(
      "POST",
      `/pipelines/${runId}/questions/${pending.id}/answer`,
      { value: "A" },
    );
    expect(first.statusCode).toBe(200);

    const second = await request(
      "POST",
      `/pipelines/${runId}/questions/${pending.id}/answer`,
      { value: "A" },
    );
    expect(second.statusCode).toBe(409);
    expect(String(second.data.error)).toMatch(
      /already answered|No pending question/i,
    );

    await waitForStatus(runId, ["completed", "failed"]);
  });

  it("rejects answer with missing value", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pending = await waitForPendingQuestion(runId, 4000);

    const { statusCode, data } = await request(
      "POST",
      `/pipelines/${runId}/questions/${pending.id}/answer`,
      { text: "some text but no value" },
    );
    expect(statusCode).toBe(400);
    expect(data.error).toContain("Missing answer value");

    await request("POST", `/pipelines/${runId}/questions/${pending.id}/answer`, {
      value: "A",
    });
    await waitForStatus(runId, ["completed", "failed"]);
  });

  it("restores waiting question after server restart", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pendingBeforeRestart = await waitForPendingQuestion(runId);

    await restartServer();

    const statusAfterRestart = await waitForStatus(runId, ["waiting_for_answer"]);
    const pendingAfterRestart = statusAfterRestart.pendingQuestion as {
      id: string;
    };
    expect(pendingAfterRestart.id).toBe(pendingBeforeRestart.id);

    const answerResponse = await request(
      "POST",
      `/pipelines/${runId}/questions/${pendingAfterRestart.id}/answer`,
      { value: "A" },
    );
    expect(answerResponse.statusCode).toBe(200);

    const finalStatus = await waitForStatus(runId, ["completed", "failed"]);
    expect(finalStatus.status).toBe("completed");
  });

  it("atomic durable saves preserve happy-path behavior", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pending = await waitForPendingQuestion(runId);

    const runDir = path.join(tmpLogsRoot, runId);
    expect(fs.existsSync(path.join(runDir, "run-state.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "checkpoint.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(runDir, "questions", `${pending.id}.json`)),
    ).toBe(true);
    expect(listTmpFilesRecursive(runDir)).toEqual([]);

    const answered = await request(
      "POST",
      `/pipelines/${runId}/questions/${pending.id}/answer`,
      { value: "A" },
    );
    expect(answered.statusCode).toBe(200);
    await waitForStatus(runId, ["completed"]);

    expect(listTmpFilesRecursive(runDir)).toEqual([]);
    expect(() =>
      JSON.parse(fs.readFileSync(path.join(runDir, "run-state.json"), "utf-8")),
    ).not.toThrow();
    expect(() =>
      JSON.parse(fs.readFileSync(path.join(runDir, "checkpoint.json"), "utf-8")),
    ).not.toThrow();
    expect(() =>
      JSON.parse(
        fs.readFileSync(
          path.join(runDir, "questions", `${pending.id}.json`),
          "utf-8",
        ),
      ),
    ).not.toThrow();
  });
});

describe("HTTP Server: POST /pipelines/{id}/steer", () => {
  it("queues steering for a running manager loop", async () => {
    const steeringQueue = new InMemorySteeringQueue();

    await restartServer({
      steeringQueue,
      managerObserverFactory: async () => ({
        observe: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { childStatus: "completed", childOutcome: "success" };
        },
      }),
    });

    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: MANAGER_LOOP_DOT,
    });
    const runId = runData.runId as string;

    const status = await waitForStatus(runId, ["running"], 5000, 25);
    expect(status.currentNode).toBe("manager");

    const response = await request("POST", `/pipelines/${runId}/steer`, {
      message: "Focus on the failing test first.",
    });

    expect(response.statusCode).toBe(200);
    expect(response.data.delivery).toBe("queued");
    expect(steeringQueue.peek({ runId, executionId: "child-thread", nodeId: "child" })).toMatchObject([
      {
        message: "Focus on the failing test first.",
        source: "api",
      },
    ]);
  });

  it("returns 409 when no active manager target is known yet", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;

    await waitForStatus(runId, ["waiting_for_answer"]);
    const response = await request("POST", `/pipelines/${runId}/steer`, {
      message: "Hello",
    });

    expect(response.statusCode).toBe(409);
    expect(response.data.error).toContain("active manager steering target");
  });

  it("returns 409 when no active manager-loop-bound child session exists", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    await waitForStatus(runId, ["completed"]);
    const response = await request("POST", `/pipelines/${runId}/steer`, {
      message: "Hello",
    });

    expect(response.statusCode).toBe(409);
    expect(response.data.error).toContain("already completed");
  });
});

describe("HTTP Server: recovery hardening for malformed durable JSON", () => {
  it("recovered run status includes context restored from checkpoint", async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    const run = path.join(tmpLogsRoot, "run-1");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(
      path.join(run, "run-state.json"),
      JSON.stringify({
        runId: "run-1",
        status: "waiting_for_answer",
        currentNode: "review",
        completedNodes: ["start"],
        pendingQuestionId: "q-0001",
        updatedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(
      path.join(run, "checkpoint.json"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        currentNode: "start",
        completedNodes: ["start"],
        nodeRetries: {},
        context: {
          "graph.goal": "Recovered goal",
          "custom.key": "recovered-value",
          "internal.waiting_for_question_id": "q-0001",
        },
        logs: [],
        nodeOutcomes: {
          start: { status: "success" },
        },
        waitingForQuestionId: "q-0001",
      }),
    );

    server = createServer({ logsRoot: tmpLogsRoot }) as HttpPipelineServer;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }

    const status = await request("GET", "/pipelines/run-1");
    expect(status.statusCode).toBe(200);
    expect(status.data.status).toBe("waiting_for_answer");
    expect((status.data.context as Record<string, unknown>)["custom.key"]).toBe(
      "recovered-value",
    );
  });

  it("malformed run-state.json does not crash server startup", async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    const brokenRun = path.join(tmpLogsRoot, "run-1");
    fs.mkdirSync(brokenRun, { recursive: true });
    fs.writeFileSync(path.join(brokenRun, "run-state.json"), "{");

    const healthyRun = path.join(tmpLogsRoot, "run-2");
    fs.mkdirSync(healthyRun, { recursive: true });
    fs.writeFileSync(
      path.join(healthyRun, "run-state.json"),
      JSON.stringify({
        runId: "run-2",
        status: "completed",
        currentNode: "exit",
        completedNodes: ["start", "exit"],
        pendingQuestionId: null,
        updatedAt: new Date().toISOString(),
      }),
    );

    server = createServer({ logsRoot: tmpLogsRoot }) as HttpPipelineServer;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }

    const healthy = await request("GET", "/pipelines/run-2");
    expect(healthy.statusCode).toBe(200);
    expect(healthy.data.status).toBe("completed");

    const broken = await request("GET", "/pipelines/run-1");
    expect(broken.statusCode).toBe(404);
  });

  it("malformed question file does not crash recovery of unrelated runs", async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    const run1 = path.join(tmpLogsRoot, "run-1");
    fs.mkdirSync(path.join(run1, "questions"), { recursive: true });
    fs.writeFileSync(
      path.join(run1, "run-state.json"),
      JSON.stringify({
        runId: "run-1",
        status: "waiting_for_answer",
        currentNode: "review",
        completedNodes: ["start"],
        pendingQuestionId: "q-0001",
        updatedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(path.join(run1, "questions", "q-0001.json"), "{");

    const run2 = path.join(tmpLogsRoot, "run-2");
    fs.mkdirSync(run2, { recursive: true });
    fs.writeFileSync(
      path.join(run2, "run-state.json"),
      JSON.stringify({
        runId: "run-2",
        status: "completed",
        currentNode: "exit",
        completedNodes: ["start", "exit"],
        pendingQuestionId: null,
        updatedAt: new Date().toISOString(),
      }),
    );

    server = createServer({ logsRoot: tmpLogsRoot }) as HttpPipelineServer;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }

    const healthy = await request("GET", "/pipelines/run-2");
    expect(healthy.statusCode).toBe(200);
    expect(healthy.data.status).toBe("completed");

    const waiting = await request("GET", "/pipelines/run-1");
    expect(waiting.statusCode).toBe(200);
    expect(waiting.data.status).toBe("waiting_for_answer");
    expect(waiting.data.pendingQuestion).toBeUndefined();
  });

  it("malformed checkpoint for one run does not block other run recovery", async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    const run1 = path.join(tmpLogsRoot, "run-1");
    fs.mkdirSync(run1, { recursive: true });
    fs.writeFileSync(
      path.join(run1, "run-state.json"),
      JSON.stringify({
        runId: "run-1",
        status: "running",
        currentNode: "start",
        completedNodes: [],
        pendingQuestionId: null,
        updatedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(path.join(run1, "pipeline.dot"), SIMPLE_DOT);
    fs.writeFileSync(path.join(run1, "checkpoint.json"), "{");

    const run2 = path.join(tmpLogsRoot, "run-2");
    fs.mkdirSync(run2, { recursive: true });
    fs.writeFileSync(
      path.join(run2, "run-state.json"),
      JSON.stringify({
        runId: "run-2",
        status: "completed",
        currentNode: "exit",
        completedNodes: ["start", "exit"],
        pendingQuestionId: null,
        updatedAt: new Date().toISOString(),
      }),
    );

    server = createServer({ logsRoot: tmpLogsRoot }) as HttpPipelineServer;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }

    const healthy = await request("GET", "/pipelines/run-2");
    expect(healthy.statusCode).toBe(200);
    expect(healthy.data.status).toBe("completed");
  });
});

describe("HTTP Server: GET /pipelines/{id}/events (SSE)", () => {
  it("streams events for a running pipeline", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    // Wait for completion to ensure events exist
    await waitForStatus(runId, ["completed"]);

    // Collect SSE events (give a short window since pipeline already finished)
    const events = await collectSSEEvents(`/pipelines/${runId}/events`, 500);

    // Should have received pipeline events
    expect(events.length).toBeGreaterThan(0);

    // Should contain pipeline_started and pipeline_completed
    const types = events.map((e) => e.type);
    expect(types).toContain("pipeline_started");
    expect(types).toContain("pipeline_completed");
  });

  it("returns 404 for unknown runId", async () => {
    const { statusCode, data } = await request("GET", "/pipelines/nonexistent/events");
    expect(statusCode).toBe(404);
    expect(data.error).toContain("Unknown runId");
  });
});

describe("HTTP Server: POST /pipelines/{id}/cancel", () => {
  it("cancels a running pipeline", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;

    // Wait for the pipeline to be running or waiting for answer
    await waitForStatus(runId, ["running", "waiting_for_answer"], 2000).catch(
      () => {},
    );

    const run = server.runs.get(runId);
    // Only test cancel if the pipeline is still active
    if (run && (run.status === "running" || run.status === "waiting_for_answer")) {
      const { statusCode, data } = await request(
        "POST",
        `/pipelines/${runId}/cancel`,
      );
      expect(statusCode).toBe(200);
      expect(data.status).toBe("cancelled");

      // Status should now be cancelled
      const { data: statusData } = await request("GET", `/pipelines/${runId}`);
      expect(statusData.status).toBe("cancelled");
    }
  });

  it("cancel during pending question unblocks run safely", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: HUMAN_GATE_DOT,
    });
    const runId = runData.runId as string;
    const pending = await waitForPendingQuestion(runId);

    const cancelResponse = await request("POST", `/pipelines/${runId}/cancel`);
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.data.status).toBe("cancelled");

    const status = await waitForStatus(runId, ["cancelled"]);
    expect(status.status).toBe("cancelled");

    const questionPath = path.join(
      tmpLogsRoot,
      runId,
      "questions",
      `${pending.id}.json`,
    );
    const question = JSON.parse(fs.readFileSync(questionPath, "utf-8")) as {
      status: string;
    };
    expect(question.status).toBe("cancelled");
  });

  it("returns 409 for already completed pipeline", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    // Wait for the pipeline to complete
    await waitForStatus(runId, ["completed"]);

    const { statusCode, data } = await request(
      "POST",
      `/pipelines/${runId}/cancel`,
    );
    expect(statusCode).toBe(409);
    expect(data.error).toContain("already completed");
  });

  it("returns 404 for unknown runId", async () => {
    const { statusCode, data } = await request(
      "POST",
      "/pipelines/nonexistent/cancel",
    );
    expect(statusCode).toBe(404);
    expect(data.error).toContain("Unknown runId");
  });
});

describe("HTTP Server: GET /pipelines/{id}/checkpoint", () => {
  it("returns checkpoint state for a running pipeline", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    // Wait for completion
    await waitForStatus(runId, ["completed"]);

    const { statusCode, data } = await request(
      "GET",
      `/pipelines/${runId}/checkpoint`,
    );
    expect(statusCode).toBe(200);
    expect(data.runId).toBe(runId);
    expect(data.status).toBe("completed");
    expect(Array.isArray(data.completedNodes)).toBe(true);
  });

  it("returns 404 for unknown runId", async () => {
    const { statusCode, data } = await request(
      "GET",
      "/pipelines/nonexistent/checkpoint",
    );
    expect(statusCode).toBe(404);
    expect(data.error).toContain("Unknown runId");
  });
});

describe("HTTP Server: GET /pipelines/{id}/context", () => {
  it("returns context for a completed pipeline", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    // Wait for completion
    await waitForStatus(runId, ["completed"]);

    const { statusCode, data } = await request(
      "GET",
      `/pipelines/${runId}/context`,
    );
    expect(statusCode).toBe(200);
    expect(data.runId).toBe(runId);
    expect(data.context).toBeDefined();
    expect(typeof data.context).toBe("object");
  });

  it("returns 404 for unknown runId", async () => {
    const { statusCode, data } = await request(
      "GET",
      "/pipelines/nonexistent/context",
    );
    expect(statusCode).toBe(404);
    expect(data.error).toContain("Unknown runId");
  });
});

describe("HTTP Server: GET /pipelines/{id}/graph", () => {
  it("returns graph content for a pipeline", async () => {
    const { data: runData } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const runId = runData.runId as string;

    const result = await requestRaw("GET", `/pipelines/${runId}/graph`);
    expect(result.statusCode).toBe(200);

    // Should return either SVG (if dot is installed) or raw DOT source
    const isGraphviz = result.contentType.includes("text/vnd.graphviz");
    const isSvg = result.contentType.includes("image/svg+xml");
    expect(isGraphviz || isSvg).toBe(true);

    if (isGraphviz) {
      // Raw DOT source should contain the graph definition
      expect(result.body).toContain("digraph");
    } else {
      // SVG output should contain svg tags
      expect(result.body).toContain("<svg");
    }
  });

  it("returns 404 for unknown runId", async () => {
    const { statusCode, data } = await request(
      "GET",
      "/pipelines/nonexistent/graph",
    );
    expect(statusCode).toBe(404);
    expect(data.error).toContain("Unknown runId");
  });
});

describe("HTTP Server: Error handling", () => {
  it("returns 404 for unknown routes", async () => {
    const { statusCode, data } = await request("GET", "/unknown");
    expect(statusCode).toBe(404);
    expect(data.error).toBe("Not found");
  });

  it("returns 404 for old /run endpoint", async () => {
    const { statusCode } = await request("POST", "/run", {
      dotSource: SIMPLE_DOT,
    });
    expect(statusCode).toBe(404);
  });

  it("returns 404 for old /status endpoint", async () => {
    const { statusCode } = await request("GET", "/status/run-1");
    expect(statusCode).toBe(404);
  });

  it("returns 404 for old /events endpoint", async () => {
    const { statusCode } = await request("GET", "/events/run-1");
    expect(statusCode).toBe(404);
  });

  it("returns 404 for old /answer endpoint", async () => {
    const { statusCode } = await request("POST", "/answer/run-1", {
      value: "yes",
    });
    expect(statusCode).toBe(404);
  });

  it("returns 404 for wrong HTTP method on /pipelines", async () => {
    const { statusCode } = await request("GET", "/pipelines");
    expect(statusCode).toBe(404);
  });

  it("tracks multiple concurrent runs independently", async () => {
    // Start two pipelines
    const { data: run1Data } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });
    const { data: run2Data } = await request("POST", "/pipelines", {
      dotSource: SIMPLE_DOT,
    });

    const runId1 = run1Data.runId as string;
    const runId2 = run2Data.runId as string;
    expect(runId1).not.toBe(runId2);

    // Both should eventually complete
    const [status1, status2] = await Promise.all([
      waitForStatus(runId1, ["completed"]),
      waitForStatus(runId2, ["completed"]),
    ]);

    expect(status1.status).toBe("completed");
    expect(status2.status).toBe("completed");
  });
});
