import * as fs from "node:fs";
import * as path from "node:path";
import type { HumanPrompt, HumanPromptAnswerMap } from "../handlers/types.js";
import {
  validateHumanPrompt,
  validateHumanPromptAnswers,
} from "../handlers/human-prompt.js";
import { readJsonOrNull, writeJsonAtomic } from "../state/durable-json.js";

export type QuestionStatus =
  | "pending"
  | "answered"
  | "skipped"
  | "timeout"
  | "cancelled";

export interface QuestionRecord {
  id: string;
  runId: string;
  nodeId: string;
  stage: string;
  status: QuestionStatus;
  prompt: HumanPrompt;
  answers: HumanPromptAnswerMap | null;
  createdAt: string;
  answeredAt: string | null;
  metadata: Record<string, unknown>;
}

export type SubmitAnswerResult =
  | { ok: true; question: QuestionRecord }
  | {
      ok: false;
      reason:
        | "not_found"
        | "run_mismatch"
        | "already_answered"
        | "not_pending"
        | "invalid_answers";
      question?: QuestionRecord;
      message?: string;
    };

export class QuestionStore {
  private readonly questionsDir: string;

  constructor(private readonly logsRoot: string) {
    this.questionsDir = path.join(logsRoot, "questions");
  }

  listAll(): QuestionRecord[] {
    if (!fs.existsSync(this.questionsDir)) {
      return [];
    }
    const files = fs
      .readdirSync(this.questionsDir)
      .filter((name) => /^q-\d+\.json$/.test(name))
      .sort();
    const questions: QuestionRecord[] = [];
    for (const file of files) {
      questions.push(this.readRequired(path.join(this.questionsDir, file)));
    }
    return questions;
  }

  listPending(runId: string): QuestionRecord[] {
    return this.listAll().filter(
      (question) => question.runId === runId && question.status === "pending",
    );
  }

  findLatestPendingForStage(runId: string, stage: string): QuestionRecord | null {
    const pending = this.listPending(runId).filter(
      (question) => question.stage === stage,
    );
    if (pending.length === 0) {
      return null;
    }
    pending.sort((left, right) => right.id.localeCompare(left.id));
    return pending[0] ?? null;
  }

  findLatestForStage(runId: string, stage: string): QuestionRecord | null {
    const all = this.listAll().filter(
      (question) => question.runId === runId && question.stage === stage,
    );
    if (all.length === 0) {
      return null;
    }
    all.sort((left, right) => right.id.localeCompare(left.id));
    return all[0] ?? null;
  }

  get(questionId: string): QuestionRecord | null {
    const filePath = this.getQuestionPath(questionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return this.readRequired(filePath);
  }

  createPending(runId: string, prompt: HumanPrompt): QuestionRecord {
    fs.mkdirSync(this.questionsDir, { recursive: true });
    const id = this.nextQuestionId();
    const now = new Date().toISOString();
    const record: QuestionRecord = {
      id,
      runId,
      nodeId: prompt.stage,
      stage: prompt.stage,
      status: "pending",
      prompt,
      answers: null,
      createdAt: now,
      answeredAt: null,
      metadata: prompt.metadata ?? {},
    };
    this.write(record);
    return record;
  }

  getOrCreatePending(runId: string, prompt: HumanPrompt): QuestionRecord {
    return this.findLatestPendingForStage(runId, prompt.stage) ?? this.createPending(runId, prompt);
  }

  submitAnswers(
    runId: string,
    questionId: string,
    answers: HumanPromptAnswerMap,
  ): SubmitAnswerResult {
    const question = this.get(questionId);
    if (!question) {
      return { ok: false, reason: "not_found" };
    }
    if (question.runId !== runId) {
      return { ok: false, reason: "run_mismatch", question };
    }
    if (question.status === "answered") {
      return { ok: false, reason: "already_answered", question };
    }
    if (question.status !== "pending") {
      return { ok: false, reason: "not_pending", question };
    }

    try {
      validateHumanPromptAnswers(question.prompt, answers);
    } catch (error) {
      return {
        ok: false,
        reason: "invalid_answers",
        question,
        message: String(error),
      };
    }

    const updated: QuestionRecord = {
      ...question,
      status: "answered",
      answers,
      answeredAt: new Date().toISOString(),
    };
    this.write(updated);
    return { ok: true, question: updated };
  }

  markCancelled(runId: string, questionId: string): QuestionRecord | null {
    const question = this.get(questionId);
    if (!question || question.runId !== runId || question.status !== "pending") {
      return null;
    }
    const updated: QuestionRecord = {
      ...question,
      status: "cancelled",
      answers: null,
      answeredAt: new Date().toISOString(),
    };
    this.write(updated);
    return updated;
  }

  private getQuestionPath(questionId: string): string {
    return path.join(this.questionsDir, `${questionId}.json`);
  }

  private write(question: QuestionRecord): void {
    fs.mkdirSync(this.questionsDir, { recursive: true });
    writeJsonAtomic(this.getQuestionPath(question.id), question);
  }

  private nextQuestionId(): string {
    const all = this.listAll();
    let max = 0;
    for (const question of all) {
      const match = /^q-(\d+)$/.exec(question.id);
      if (match) {
        const num = Number(match[1]);
        if (Number.isFinite(num)) {
          max = Math.max(max, num);
        }
      }
    }
    return `q-${String(max + 1).padStart(4, "0")}`;
  }

  private readRequired(filePath: string): QuestionRecord {
    const parsed = readJsonOrNull<Record<string, unknown>>(filePath);
    if (!parsed) {
      throw new Error(`Question record '${filePath}' is unreadable`);
    }

    if (!("prompt" in parsed)) {
      throw new Error(
        `Question record '${filePath}' uses the legacy question/answer shape; expected prompt`,
      );
    }

    const prompt = validateHumanPrompt(parsed.prompt);
    const answers = this.readAnswers(parsed.answers, prompt, filePath);
    const status = readQuestionStatus(parsed.status, filePath);
    const runId = readString(parsed.runId, `${filePath} is missing runId`);
    const id = readString(parsed.id, `${filePath} is missing id`);
    const nodeId = readString(parsed.nodeId, `${filePath} is missing nodeId`);
    const stage = readString(parsed.stage, `${filePath} is missing stage`);
    const createdAt = readString(parsed.createdAt, `${filePath} is missing createdAt`);
    const answeredAt = readNullableString(parsed.answeredAt, `${filePath} has invalid answeredAt`);
    const metadata = readMetadata(parsed.metadata);

    return {
      id,
      runId,
      nodeId,
      stage,
      status,
      prompt,
      answers,
      createdAt,
      answeredAt,
      metadata,
    };
  }

  private readAnswers(
    rawAnswers: unknown,
    prompt: HumanPrompt,
    filePath: string,
  ): HumanPromptAnswerMap | null {
    if (rawAnswers === null || rawAnswers === undefined) {
      return null;
    }
    if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
      throw new Error(`Question record '${filePath}' has invalid answers payload`);
    }
    validateHumanPromptAnswers(prompt, rawAnswers);
    return rawAnswers as HumanPromptAnswerMap;
  }
}

function readQuestionStatus(value: unknown, filePath: string): QuestionStatus {
  const allowed: QuestionStatus[] = ["pending", "answered", "skipped", "timeout", "cancelled"];
  if (typeof value !== "string" || !allowed.includes(value as QuestionStatus)) {
    throw new Error(`Question record '${filePath}' has invalid status`);
  }
  return value as QuestionStatus;
}

function readString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function readNullableString(value: unknown, message: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Question record metadata must be an object");
  }
  return value as Record<string, unknown>;
}
