import type { HumanPrompt, HumanPromptState, Interviewer } from "../handlers/types.js";
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

  async ask(prompt: HumanPrompt): Promise<HumanPromptState> {
    const resumeQuestionId = this.getResumeQuestionId(prompt);
    if (resumeQuestionId) {
      const record = this.questionStore.get(resumeQuestionId);
      if (!record) {
        throw new Error(
          `Resume prompt '${resumeQuestionId}' for stage '${prompt.stage}' was not found`,
        );
      }
      if (record.runId !== this.runId) {
        throw new Error(
          `Resume prompt '${resumeQuestionId}' for stage '${prompt.stage}' belongs to run '${record.runId}', expected '${this.runId}'`,
        );
      }
      if (record.status === "answered") {
        if (!record.answers) {
          throw new Error(
            `Resume prompt '${resumeQuestionId}' for stage '${prompt.stage}' is answered but has no stored answers`,
          );
        }
        return { state: "answered", answers: record.answers, promptId: record.id };
      }
      if (record.status === "pending") {
        this.hooks.onWaiting(record);
        return { state: "waiting", promptId: record.id };
      }
      if (record.status === "timeout") {
        return { state: "timeout", promptId: record.id };
      }
      return { state: "skipped", promptId: record.id };
    }

    const pending = this.questionStore.getOrCreatePending(this.runId, prompt);
    this.hooks.onWaiting(pending);
    return { state: "waiting", promptId: pending.id };
  }

  private getResumeQuestionId(prompt: HumanPrompt): string {
    const metadata = prompt.metadata;
    if (!metadata || typeof metadata !== "object") {
      return "";
    }
    const raw = metadata.resumeQuestionId;
    return typeof raw === "string" ? raw : "";
  }
}
