import { describe, expect, it } from "vitest";
import {
  ConfidenceGateHandler,
  FailureAnalyzeHandler,
  JudgeRubricHandler,
  QualityGateHandler,
} from "../src/handlers/handlers.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import type { Graph, GraphNode } from "../src/model/graph.js";

function makeNode(
  type: GraphNode["type"],
  overrides: Partial<GraphNode> & { attrs?: Record<string, unknown> } = {},
): GraphNode {
  return {
    id: type.replaceAll(".", "_"),
    label: type,
    shape: "box",
    type,
    prompt: "",
    maxRetries: 0,
    goalGate: false,
    retryTarget: "",
    fallbackRetryTarget: "",
    fidelity: "",
    threadId: "",
    classes: [],
    timeout: null,
    llmModel: "",
    llmProvider: "",
    reasoningEffort: "high",
    autoStatus: false,
    allowPartial: false,
    attrs: {},
    ...overrides,
  };
}

const stubGraph = {
  attrs: {
    goal: "Test custom handlers",
    label: "",
    modelStylesheet: "",
    defaultMaxRetry: 0,
    retryTarget: "",
    fallbackRetryTarget: "",
    defaultFidelity: "",
    vars: [],
    varsExplicit: false,
  },
} as Graph;

describe("JudgeRubricHandler", () => {
  it("writes deterministic rubric outputs on pass", async () => {
    const ctx = new Context();
    ctx.set("artifact.body", "Implementation details");
    const handler = new JudgeRubricHandler({
      async run() {
        return JSON.stringify({
          score: 0.91,
          summary: "Looks solid",
        });
      },
    });

    const outcome = await handler.execute(
      makeNode("judge.rubric", {
        prompt: "Review the artifact",
        attrs: {
          "judge.input_key": "artifact.body",
          "judge.threshold": "0.8",
        },
      }),
      ctx,
      stubGraph,
      "/tmp",
    );

    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.contextUpdates).toEqual({
      "judge.rubric.score": 0.91,
      "judge.rubric.summary": "Looks solid",
      "judge.rubric.result": "pass",
    });
  });

  it("fails closed on malformed structured output", async () => {
    const ctx = new Context();
    ctx.set("artifact.body", "Implementation details");
    const handler = new JudgeRubricHandler({
      async run() {
        return JSON.stringify({
          score: "not-a-number",
          summary: "",
        });
      },
    });

    const outcome = await handler.execute(
      makeNode("judge.rubric", {
        attrs: { "judge.input_key": "artifact.body" },
      }),
      ctx,
      stubGraph,
      "/tmp",
    );

    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("malformed");
  });
});

describe("FailureAnalyzeHandler", () => {
  it("writes deterministic failure outputs", async () => {
    const ctx = new Context();
    ctx.set("failure.reason", "Timed out contacting upstream");
    const handler = new FailureAnalyzeHandler({
      async run() {
        return JSON.stringify({
          class: "transient",
          summary: "Network timeout",
          recommendation: "Retry after backoff",
        });
      },
    });

    const outcome = await handler.execute(
      makeNode("failure.analyze"),
      ctx,
      stubGraph,
      "/tmp",
    );

    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.contextUpdates).toEqual({
      "failure.analyze.class": "transient",
      "failure.analyze.summary": "Network timeout",
      "failure.analyze.recommendation": "Retry after backoff",
    });
  });

  it("fails closed on invalid class", async () => {
    const ctx = new Context();
    ctx.set("failure.reason", "Something broke");
    const handler = new FailureAnalyzeHandler({
      async run() {
        return JSON.stringify({
          class: "unknown",
          summary: "Bad result",
          recommendation: "Do something",
        });
      },
    });

    const outcome = await handler.execute(
      makeNode("failure.analyze"),
      ctx,
      stubGraph,
      "/tmp",
    );

    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("malformed");
  });
});

describe("ConfidenceGateHandler", () => {
  it("escalates on low score or blocking failure class", async () => {
    const ctx = new Context();
    ctx.set("judge.rubric.score", 0.82);
    ctx.set("failure.analyze.class", "tool_error");
    const outcome = await new ConfidenceGateHandler().execute(
      makeNode("confidence.gate", {
        attrs: { "confidence.threshold": "0.8" },
      }),
      ctx,
      stubGraph,
      "/tmp",
    );

    expect(outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);
    expect(outcome.contextUpdates).toEqual({
      "confidence.gate.decision": "escalate",
      "confidence.gate.score": 0.82,
      "confidence.gate.reason": "failure class 'tool_error' requires escalation",
    });
  });
});

describe("QualityGateHandler", () => {
  it("aggregates failing checks deterministically", async () => {
    const ctx = new Context();
    ctx.set("tests.pass", "true");
    ctx.set("lint.pass", "false");
    const outcome = await new QualityGateHandler().execute(
      makeNode("quality.gate", {
        attrs: {
          "quality.checks": JSON.stringify([
            { label: "tests", condition: "tests.pass=true" },
            { label: "lint", condition: "lint.pass=true" },
          ]),
        },
      }),
      ctx,
      stubGraph,
      "/tmp",
    );

    expect(outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);
    expect(outcome.contextUpdates).toEqual({
      "quality.gate.result": "fail",
      "quality.gate.failed_checks": JSON.stringify(["lint"]),
      "quality.gate.summary": "Failed checks: lint",
    });
  });

  it("fails closed on invalid config", async () => {
    const outcome = await new QualityGateHandler().execute(
      makeNode("quality.gate"),
      new Context(),
      stubGraph,
      "/tmp",
    );

    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("quality.checks");
  });
});
