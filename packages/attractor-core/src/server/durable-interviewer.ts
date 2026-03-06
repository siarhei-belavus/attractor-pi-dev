import type { Answer, Interviewer, Question } from "../handlers/types.js";
import { AnswerValue } from "../handlers/types.js";
import type { QuestionRecord } from "./question-store.js";
import { QuestionStore } from "./question-store.js";

export interface DurableInterviewerHooks {
  onWaiting(question: QuestionRecord): void;
}

export class DurableInterviewer implements Interviewer {
  constructor(
    private readonly runId: string,
    private readonly questionStore: QuestionStore,
    private readonly hooks: DurableInterviewerHooks,
  ) {}

  async ask(question: Question): Promise<Answer> {
    const resumeQuestionId = this.getResumeQuestionId(question);
    if (resumeQuestionId) {
      const record = this.questionStore.get(resumeQuestionId);
      if (record && record.runId === this.runId) {
        if (record.status === "answered" && record.answer) {
          return this.attachQuestionId(record.answer, record.id);
        }
        if (record.status === "pending") {
          this.hooks.onWaiting(record);
          return { value: AnswerValue.WAITING, questionId: record.id };
        }
        if (record.status === "timeout") {
          return { value: AnswerValue.TIMEOUT, questionId: record.id };
        }
        return { value: AnswerValue.SKIPPED, questionId: record.id };
      }
    }

    const pendingExisting = this.questionStore.findLatestPendingForStage(
      this.runId,
      question.stage,
    );
    const pending = pendingExisting ?? this.questionStore.createPending(this.runId, question);
    this.hooks.onWaiting(pending);
    return { value: AnswerValue.WAITING, questionId: pending.id };
  }

  private getResumeQuestionId(question: Question): string {
    const metadata = question.metadata;
    if (!metadata || typeof metadata !== "object") {
      return "";
    }
    const raw = metadata.resumeQuestionId;
    return typeof raw === "string" ? raw : "";
  }

  private attachQuestionId(answer: Answer, questionId: string): Answer {
    if (answer.questionId === questionId) {
      return answer;
    }
    return {
      ...answer,
      questionId,
    };
  }
}
