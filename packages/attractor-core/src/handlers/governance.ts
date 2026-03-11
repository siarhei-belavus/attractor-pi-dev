import type { Graph, GraphNode } from "../model/graph.js";
import { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";
import { StageStatus, failOutcome, successOutcome } from "../state/types.js";
import { evaluateCondition } from "../conditions/index.js";
import type { CodergenBackend, Handler } from "./types.js";
import {
  CONFIDENCE_DECISIONS,
  GOVERNANCE_CONTEXT_KEYS,
  type FailureClass,
  parseConfidenceGateConfig,
  parseFailureAnalyzeConfig,
  parseFailureAnalyzeOutput,
  parseJudgeRubricConfig,
  parseJudgeRubricOutput,
  parseQualityGateConfig,
  parseStructuredScore,
  normalizeFailureClass,
} from "./governance-contract.js";
import { executeStructuredBackend, writeStatus } from "./shared/structured-evaluator.js";

export class JudgeRubricHandler implements Handler {
  constructor(private backend: CodergenBackend | null = null) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const parsedConfig = parseJudgeRubricConfig(node);
    if (!parsedConfig.ok) {
      return failOutcome(parsedConfig.failureReason);
    }
    const config = parsedConfig.config;

    const artifact = context.get(config.inputKey);
    if (artifact === undefined || artifact === null || String(artifact).trim() === "") {
      return failOutcome(
        `judge.rubric requires context value at '${config.inputKey}'`,
      );
    }

    const prompt = [
      node.prompt || node.label || "Evaluate the artifact against the rubric.",
      graph.attrs.goal ? `Pipeline goal:\n${graph.attrs.goal}` : "",
      config.criteria ? `Rubric criteria:\n${config.criteria}` : "",
      `Artifact from context key '${config.inputKey}':\n${String(artifact)}`,
      "Return JSON with fields score (number 0..1) and summary (string).",
    ].filter(Boolean).join("\n\n");

    const backendResult = await executeStructuredBackend(
      node,
      context,
      graph,
      logsRoot,
      this.backend,
      prompt,
    );
    if ("outcome" in backendResult) {
      return backendResult.outcome;
    }

    const parsedOutput = parseJudgeRubricOutput(
      backendResult.data,
      config.threshold,
    );
    if (!parsedOutput) {
      const outcome = failOutcome(
        "judge.rubric returned malformed structured output",
      );
      writeStatus(backendResult.stageDir, outcome);
      return outcome;
    }

    const outcome = {
      status: parsedOutput.result === "pass"
        ? StageStatus.SUCCESS
        : StageStatus.PARTIAL_SUCCESS,
      contextUpdates: {
        [GOVERNANCE_CONTEXT_KEYS.judgeRubric.score]: parsedOutput.score,
        [GOVERNANCE_CONTEXT_KEYS.judgeRubric.summary]: parsedOutput.summary,
        [GOVERNANCE_CONTEXT_KEYS.judgeRubric.result]: parsedOutput.result,
      },
      notes:
        `judge.rubric ${parsedOutput.result}: `
        + `score=${parsedOutput.score.toFixed(3)} threshold=${config.threshold.toFixed(3)}`,
    } satisfies Outcome;
    writeStatus(backendResult.stageDir, outcome);
    return outcome;
  }
}

export class FailureAnalyzeHandler implements Handler {
  constructor(private backend: CodergenBackend | null = null) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const parsedConfig = parseFailureAnalyzeConfig(node);
    if (!parsedConfig.ok) {
      return failOutcome(parsedConfig.failureReason);
    }
    const config = parsedConfig.config;

    const failureInput = context.get(config.inputKey);
    if (
      failureInput === undefined ||
      failureInput === null ||
      String(failureInput).trim() === ""
    ) {
      return failOutcome(
        `failure.analyze requires context value at '${config.inputKey}'`,
      );
    }

    const prompt = [
      node.prompt || node.label || "Analyze the failure context.",
      graph.attrs.goal ? `Pipeline goal:\n${graph.attrs.goal}` : "",
      config.hints ? `Analysis hints:\n${config.hints}` : "",
      `Failure context from '${config.inputKey}':\n${String(failureInput)}`,
      "Return JSON with fields class (transient|quality_gap|tool_error|spec_mismatch), summary (string), recommendation (string).",
    ].filter(Boolean).join("\n\n");

    const backendResult = await executeStructuredBackend(
      node,
      context,
      graph,
      logsRoot,
      this.backend,
      prompt,
    );
    if ("outcome" in backendResult) {
      return backendResult.outcome;
    }

    const parsedOutput = parseFailureAnalyzeOutput(backendResult.data);
    if (!parsedOutput) {
      const outcome = failOutcome(
        "failure.analyze returned malformed structured output",
      );
      writeStatus(backendResult.stageDir, outcome);
      return outcome;
    }

    const outcome = successOutcome({
      contextUpdates: {
        [GOVERNANCE_CONTEXT_KEYS.failureAnalyze.failureClass]: parsedOutput.failureClass,
        [GOVERNANCE_CONTEXT_KEYS.failureAnalyze.summary]: parsedOutput.summary,
        [GOVERNANCE_CONTEXT_KEYS.failureAnalyze.recommendation]: parsedOutput.recommendation,
      },
      notes: `failure.analyze classified ${parsedOutput.failureClass}`,
    });
    writeStatus(backendResult.stageDir, outcome);
    return outcome;
  }
}

export class ConfidenceGateHandler implements Handler {
  async execute(
    node: GraphNode,
    context: Context,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const parsedConfig = parseConfidenceGateConfig(node);
    if (!parsedConfig.ok) {
      return failOutcome(parsedConfig.failureReason);
    }
    const config = parsedConfig.config;

    const failureClass = normalizeFailureClass(context.get(config.failureClassKey));
    const score = resolveConfidenceScore(context, config.scoreKey, failureClass);
    if (score === null) {
      return failOutcome(
        `confidence.gate requires a normalized score at '${config.scoreKey}' or prior quality/failure signals`,
      );
    }

    let decision = CONFIDENCE_DECISIONS[score >= config.threshold ? 0 : 1];
    let reason = score >= config.threshold
      ? `score ${score.toFixed(3)} met threshold ${config.threshold.toFixed(3)}`
      : `score ${score.toFixed(3)} fell below threshold ${config.threshold.toFixed(3)}`;

    if (failureClass && config.escalateClasses.includes(failureClass)) {
      decision = "escalate";
      reason = `failure class '${failureClass}' requires escalation`;
    }

    return {
      status: decision === "autonomous"
        ? StageStatus.SUCCESS
        : StageStatus.PARTIAL_SUCCESS,
      contextUpdates: {
        [GOVERNANCE_CONTEXT_KEYS.confidenceGate.decision]: decision,
        [GOVERNANCE_CONTEXT_KEYS.confidenceGate.score]: score,
        [GOVERNANCE_CONTEXT_KEYS.confidenceGate.reason]: reason,
      },
      notes: `confidence.gate ${decision}`,
    };
  }
}

export class QualityGateHandler implements Handler {
  async execute(
    node: GraphNode,
    context: Context,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const parsedConfig = parseQualityGateConfig(node);
    if (!parsedConfig.ok) {
      return failOutcome(parsedConfig.failureReason);
    }

    const synthetic = successOutcome();
    const failedChecks = parsedConfig.config.checks
      .filter((check) => !evaluateCondition(check.condition, synthetic, context))
      .map((check) => check.label);

    const passed = failedChecks.length === 0;
    return {
      status: passed ? StageStatus.SUCCESS : StageStatus.PARTIAL_SUCCESS,
      contextUpdates: {
        [GOVERNANCE_CONTEXT_KEYS.qualityGate.result]: passed ? "pass" : "fail",
        [GOVERNANCE_CONTEXT_KEYS.qualityGate.failedChecks]: JSON.stringify(failedChecks),
        [GOVERNANCE_CONTEXT_KEYS.qualityGate.summary]: passed
          ? `All ${parsedConfig.config.checks.length} quality checks passed`
          : `Failed checks: ${failedChecks.join(", ")}`,
      },
      notes:
        `quality.gate ${passed ? "pass" : "fail"} `
        + `(${parsedConfig.config.checks.length} checks)`,
    };
  }
}

function resolveConfidenceScore(
  context: Context,
  scoreKey: string,
  failureClass: FailureClass | "",
): number | null {
  const directScore = parseStructuredScore(context.get(scoreKey));
  if (directScore !== null) {
    return directScore;
  }

  const qualityGateResult = context.getString(
    GOVERNANCE_CONTEXT_KEYS.qualityGate.result,
  );
  if (qualityGateResult === "pass") {
    return 1;
  }
  if (qualityGateResult === "fail") {
    return 0;
  }

  if (failureClass === "transient") {
    return 0.5;
  }
  if (failureClass) {
    return 0;
  }

  return null;
}
