import type { GraphNode } from "../model/graph.js";

export const FAILURE_CLASSES = [
  "transient",
  "quality_gap",
  "tool_error",
  "spec_mismatch",
] as const;

export const CONFIDENCE_DECISIONS = ["autonomous", "escalate"] as const;
export const JUDGE_RUBRIC_RESULTS = ["pass", "revise"] as const;
export const QUALITY_GATE_RESULTS = ["pass", "fail"] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];
export type ConfidenceDecision = (typeof CONFIDENCE_DECISIONS)[number];
export type JudgeRubricResult = (typeof JUDGE_RUBRIC_RESULTS)[number];
export type QualityGateResult = (typeof QUALITY_GATE_RESULTS)[number];

export interface QualityGateCheck {
  label: string;
  condition: string;
  summary: string;
}

export interface JudgeRubricConfig {
  inputKey: string;
  threshold: number;
  criteria: string;
}

export interface FailureAnalyzeConfig {
  inputKey: string;
  hints: string;
}

export interface ConfidenceGateConfig {
  threshold: number;
  scoreKey: string;
  failureClassKey: string;
  escalateClasses: FailureClass[];
}

export interface QualityGateConfig {
  checks: QualityGateCheck[];
}

export interface JudgeRubricOutput {
  score: number;
  summary: string;
  result: JudgeRubricResult;
}

export interface FailureAnalyzeOutput {
  failureClass: FailureClass;
  summary: string;
  recommendation: string;
}

export interface ConfigParseSuccess<T> {
  ok: true;
  config: T;
}

export interface ConfigParseFailure {
  ok: false;
  failureReason: string;
}

export type ConfigParseResult<T> = ConfigParseSuccess<T> | ConfigParseFailure;

export const GOVERNANCE_CONTEXT_KEYS = {
  judgeRubric: {
    score: "judge.rubric.score",
    summary: "judge.rubric.summary",
    result: "judge.rubric.result",
  },
  failureAnalyze: {
    failureReason: "failure.reason",
    failureClass: "failure.analyze.class",
    summary: "failure.analyze.summary",
    recommendation: "failure.analyze.recommendation",
  },
  confidenceGate: {
    decision: "confidence.gate.decision",
    score: "confidence.gate.score",
    reason: "confidence.gate.reason",
  },
  qualityGate: {
    result: "quality.gate.result",
    failedChecks: "quality.gate.failed_checks",
    summary: "quality.gate.summary",
  },
} as const;

export function parseJudgeRubricConfig(node: GraphNode): ConfigParseResult<JudgeRubricConfig> {
  const threshold = parseFractionAttr(node, "judge.threshold", 0.75);
  if (threshold === null) {
    return { ok: false, failureReason: "judge.rubric requires judge.threshold in range [0,1]" };
  }

  return {
    ok: true,
    config: {
      inputKey: getAttrString(node, "judge.input_key") || "last_response",
      threshold,
      criteria: getAttrString(node, "judge.criteria"),
    },
  };
}

export function parseFailureAnalyzeConfig(node: GraphNode): ConfigParseResult<FailureAnalyzeConfig> {
  return {
    ok: true,
    config: {
      inputKey: getAttrString(node, "failure.input_key") || GOVERNANCE_CONTEXT_KEYS.failureAnalyze.failureReason,
      hints: getAttrString(node, "failure.hints"),
    },
  };
}

export function parseConfidenceGateConfig(node: GraphNode): ConfigParseResult<ConfidenceGateConfig> {
  const threshold = parseFractionAttr(node, "confidence.threshold", 0.75);
  if (threshold === null) {
    return { ok: false, failureReason: "confidence.gate requires confidence.threshold in range [0,1]" };
  }

  const rawEscalateClasses = parseCsvAttr(
    node,
    "confidence.escalate_classes",
    ["quality_gap", "tool_error", "spec_mismatch"],
  );
  const escalateClasses = rawEscalateClasses
    .map((value) => normalizeFailureClass(value))
    .filter((value): value is FailureClass => Boolean(value));

  return {
    ok: true,
    config: {
      threshold,
      scoreKey: getAttrString(node, "confidence.score_key") || GOVERNANCE_CONTEXT_KEYS.judgeRubric.score,
      failureClassKey:
        getAttrString(node, "confidence.failure_class_key")
        || GOVERNANCE_CONTEXT_KEYS.failureAnalyze.failureClass,
      escalateClasses,
    },
  };
}

export function parseQualityGateConfig(node: GraphNode): ConfigParseResult<QualityGateConfig> {
  const raw = node.attrs["quality.checks"];
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      failureReason: "quality.gate requires quality.checks as a JSON array of checks",
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        ok: false,
        failureReason: "quality.gate requires quality.checks as a JSON array of checks",
      };
    }

    const checks = parsed.map((entry, index) => parseQualityGateCheck(entry, index));
    if (!checks.every(Boolean)) {
      return {
        ok: false,
        failureReason: "quality.gate requires quality.checks as a JSON array of checks",
      };
    }

    return {
      ok: true,
      config: {
        checks: checks as QualityGateCheck[],
      },
    };
  } catch {
    return {
      ok: false,
      failureReason: "quality.gate requires quality.checks as a JSON array of checks",
    };
  }
}

export function parseJudgeRubricOutput(
  data: Record<string, unknown>,
  threshold: number,
): JudgeRubricOutput | null {
  const score = parseStructuredScore(data.score ?? data.overall_score);
  const summary = parseNonEmptyString(data.summary ?? data.rationale);
  if (score === null || !summary) {
    return null;
  }

  return {
    score,
    summary,
    result: score >= threshold ? "pass" : "revise",
  };
}

export function parseFailureAnalyzeOutput(
  data: Record<string, unknown>,
): FailureAnalyzeOutput | null {
  const failureClass = normalizeFailureClass(data.class ?? data.failure_class);
  const summary = parseNonEmptyString(data.summary);
  const recommendation = parseNonEmptyString(data.recommendation);
  if (!failureClass || !summary || !recommendation) {
    return null;
  }

  return {
    failureClass,
    summary,
    recommendation,
  };
}

export function normalizeFailureClass(value: unknown): FailureClass | "" {
  const candidate = String(value ?? "").trim().toLowerCase();
  return FAILURE_CLASSES.includes(candidate as FailureClass)
    ? (candidate as FailureClass)
    : "";
}

export function parseStructuredScore(value: unknown): number | null {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    return null;
  }
  return score;
}

export function parseNonEmptyString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function getAttrString(node: GraphNode, key: string): string {
  const value = node.attrs[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function parseFractionAttr(
  node: GraphNode,
  key: string,
  fallback: number,
): number | null {
  const raw = getAttrString(node, key);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

function parseCsvAttr(
  node: GraphNode,
  key: string,
  fallback: string[],
): string[] {
  const raw = getAttrString(node, key);
  if (!raw) {
    return [...fallback];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseQualityGateCheck(entry: unknown, index: number): QualityGateCheck | null {
  if (typeof entry === "string" && entry.trim()) {
    return {
      label: `check_${index + 1}`,
      condition: entry,
      summary: entry,
    };
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;
  const label = parseNonEmptyString(candidate.label) || `check_${index + 1}`;
  const condition = parseNonEmptyString(candidate.condition);
  const summary = parseNonEmptyString(candidate.summary) || label;
  if (!condition) {
    return null;
  }

  return { label, condition, summary };
}
