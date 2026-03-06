import * as fs from "node:fs";
import * as path from "node:path";
import type { Answer, Question } from "../handlers/types.js";
import { AnswerValue } from "../handlers/types.js";
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
  question: Question;
  answer: Answer | null;
  createdAt: string;
  answeredAt: string | null;
  metadata: Record<string, unknown>;
}

export type SubmitAnswerResult =
  | { ok: true; question: QuestionRecord }
  | { ok: false; reason: "not_found" | "run_mismatch" | "already_answered" | "not_pending"; question?: QuestionRecord };

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
      const fullPath = path.join(this.questionsDir, file);
      const parsed = readJsonOrNull<QuestionRecord>(fullPath);
      if (parsed) {
        questions.push(parsed);
      }
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
    return readJsonOrNull<QuestionRecord>(filePath);
  }

  createPending(runId: string, question: Question): QuestionRecord {
    fs.mkdirSync(this.questionsDir, { recursive: true });
    const id = this.nextQuestionId();
    const now = new Date().toISOString();
    const record: QuestionRecord = {
      id,
      runId,
      nodeId: question.stage,
      stage: question.stage,
      status: "pending",
      question,
      answer: null,
      createdAt: now,
      answeredAt: null,
      metadata: question.metadata ?? {},
    };
    this.write(record);
    return record;
  }

  getOrCreatePending(runId: string, question: Question): QuestionRecord {
    const latestForStage = this.findLatestForStage(runId, question.stage);
    if (
      latestForStage &&
      latestForStage.status === "pending" &&
      latestForStage.question.text === question.text &&
      latestForStage.question.type === question.type
    ) {
      return latestForStage;
    }
    return this.createPending(runId, question);
  }

  submitAnswer(
    runId: string,
    questionId: string,
    answer: Answer,
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

    const updated: QuestionRecord = {
      ...question,
      status: "answered",
      answer,
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
      answer: { value: AnswerValue.SKIPPED, questionId: question.id },
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
}
