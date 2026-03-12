import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/model/graph.js";
import { Context } from "../src/state/context.js";
import { applyOutcomeRuntimeContext } from "../src/state/outcome-runtime.js";
import { StageStatus } from "../src/state/types.js";
import {
  CONFIDENCE_DECISIONS,
  FAILURE_CLASSES,
  GOVERNANCE_CONTEXT_KEYS,
  parseConfidenceGateConfig,
  parseFailureAnalyzeConfig,
  parseJudgeRubricConfig,
  parseQualityGateConfig,
} from "../src/handlers/governance-contract.js";

function makeNode(
  type: GraphNode["type"],
  attrs: Record<string, unknown> = {},
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
    contextKeys: [],
    classes: [],
    timeout: null,
    llmModel: "",
    llmProvider: "",
    reasoningEffort: "high",
    autoStatus: false,
    allowPartial: false,
    attrs,
  };
}

describe("governance contract", () => {
  it("exposes stable context key constants", () => {
    expect(GOVERNANCE_CONTEXT_KEYS.judgeRubric.score).toBe("judge.rubric.score");
    expect(GOVERNANCE_CONTEXT_KEYS.failureAnalyze.failureReason).toBe("failure.reason");
    expect(GOVERNANCE_CONTEXT_KEYS.confidenceGate.decision).toBe("confidence.gate.decision");
    expect(GOVERNANCE_CONTEXT_KEYS.qualityGate.result).toBe("quality.gate.result");
  });

  it("limits failure classes and confidence decisions to bounded enums", () => {
    expect(FAILURE_CLASSES).toEqual([
      "transient",
      "quality_gap",
      "tool_error",
      "spec_mismatch",
    ]);
    expect(CONFIDENCE_DECISIONS).toEqual(["autonomous", "escalate"]);
  });

  it("parses typed configs with explicit change points", () => {
    const judge = parseJudgeRubricConfig(
      makeNode("judge.rubric", {
        "judge.input_key": "artifact.body",
        "judge.threshold": "0.9",
        "judge.criteria": "Correctness first",
      }),
    );
    const failure = parseFailureAnalyzeConfig(
      makeNode("failure.analyze", {
        "failure.input_key": "failure.reason",
        "failure.hints": "Use retry taxonomy",
      }),
    );
    const confidence = parseConfidenceGateConfig(
      makeNode("confidence.gate", {
        "confidence.threshold": "0.85",
        "confidence.score_key": "judge.rubric.score",
        "confidence.failure_class_key": "failure.analyze.class",
        "confidence.escalate_classes": "tool_error,spec_mismatch",
      }),
    );
    const quality = parseQualityGateConfig(
      makeNode("quality.gate", {
        "quality.checks": JSON.stringify([
          { label: "tests", condition: "tests.pass=true" },
        ]),
      }),
    );

    expect(judge).toMatchObject({
      ok: true,
      config: {
        inputKey: "artifact.body",
        threshold: 0.9,
        criteria: "Correctness first",
      },
    });
    expect(failure).toMatchObject({
      ok: true,
      config: {
        inputKey: "failure.reason",
        hints: "Use retry taxonomy",
      },
    });
    expect(confidence).toMatchObject({
      ok: true,
      config: {
        threshold: 0.85,
        scoreKey: "judge.rubric.score",
        failureClassKey: "failure.analyze.class",
        escalateClasses: ["tool_error", "spec_mismatch"],
      },
    });
    expect(quality).toMatchObject({
      ok: true,
      config: {
        checks: [{ label: "tests", condition: "tests.pass=true", summary: "tests" }],
      },
    });
  });

  it("applies outcome runtime policy consistently", () => {
    const context = new Context();
    applyOutcomeRuntimeContext(context, {
      status: StageStatus.FAIL,
      failureReason: "Timed out",
      preferredLabel: "retry",
    });

    expect(context.getString("outcome")).toBe(StageStatus.FAIL);
    expect(context.getString("failure.reason")).toBe("Timed out");
    expect(context.getString("preferred_label")).toBe("retry");
  });
});
