import type {
  Answer,
  HumanPrompt,
  HumanPromptAnswerMap,
  HumanPromptState,
  Interviewer,
} from "./types.js";
import { AnswerValue, QuestionType } from "./types.js";

/** Always approves - for testing and CI/CD */
export class AutoApproveInterviewer implements Interviewer {
  async ask(prompt: HumanPrompt): Promise<HumanPromptState> {
    if (prompt.metadata?.handlerType !== "wait.human" || prompt.questions.length !== 1) {
      throw new Error("Auto-approve only supports wait.human prompts");
    }
    const question = prompt.questions[0]!;
    if (question.type !== QuestionType.MULTIPLE_CHOICE) {
      throw new Error("Auto-approve only supports wait.human multiple-choice prompts");
    }
    const options = question.options ?? [];
    if (options.length === 0) {
      throw new Error("wait.human prompt is missing options");
    }
    const first = options[0]!;
    return {
      state: "answered",
      answers: {
        [question.key]: {
          value: first.key,
          selectedOption: first,
        },
      },
    };
  }
}

/** Delegates to a callback function */
export class CallbackInterviewer implements Interviewer {
  constructor(private callback: (prompt: HumanPrompt) => Promise<HumanPromptState>) {}

  async ask(prompt: HumanPrompt): Promise<HumanPromptState> {
    return this.callback(prompt);
  }
}

/** Reads answers from a pre-filled queue - for testing */
export class QueueInterviewer implements Interviewer {
  private queue: Array<Answer | HumanPromptAnswerMap | HumanPromptState>;

  constructor(answers: Array<Answer | HumanPromptAnswerMap | HumanPromptState>) {
    this.queue = [...answers];
  }

  async ask(prompt: HumanPrompt): Promise<HumanPromptState> {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (isPromptState(next)) {
        return next;
      }
      if (isAnswerMap(next)) {
        return { state: "answered", answers: next };
      }
      if (next.value === AnswerValue.WAITING) {
        return { state: "waiting", promptId: next.questionId };
      }
      if (next.value === AnswerValue.TIMEOUT) {
        return { state: "timeout", promptId: next.questionId };
      }
      if (next.value === AnswerValue.SKIPPED) {
        return { state: "skipped", promptId: next.questionId };
      }
      const onlyQuestion = prompt.questions[0];
      if (!onlyQuestion) {
        throw new Error("Queued single-answer response requires a prompt question");
      }
      return { state: "answered", answers: { [onlyQuestion.key]: next } };
    }
    return { state: "skipped" };
  }
}

/** Wraps another interviewer and records all interactions */
export class RecordingInterviewer implements Interviewer {
  recordings: Array<{ prompt: HumanPrompt; result: HumanPromptState }> = [];

  constructor(private inner: Interviewer) {}

  async ask(prompt: HumanPrompt): Promise<HumanPromptState> {
    const result = await this.inner.ask(prompt);
    this.recordings.push({ prompt, result });
    return result;
  }
}

/** Console-based interviewer for CLI usage */
export class ConsoleInterviewer implements Interviewer {
  private readline: typeof import("node:readline/promises") | null = null;

  async ask(prompt: HumanPrompt): Promise<HumanPromptState> {
    // Lazy-load readline
    if (!this.readline) {
      this.readline = await import("node:readline/promises");
    }
    const rl = this.readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log(`\n[?] ${prompt.title}`);
      const answers: HumanPromptAnswerMap = {};

      for (const question of prompt.questions) {
        console.log(`\n- ${question.text}`);

        if (question.type === QuestionType.MULTIPLE_CHOICE) {
          for (const opt of question.options ?? []) {
            console.log(`  [${opt.key}] ${opt.label}`);
          }
          const response = await rl.question("Select: ");
          const matched = (question.options ?? []).find(
            (option) => option.key.toLowerCase() === response.trim().toLowerCase(),
          );
          if (matched) {
            answers[question.key] = { value: matched.key, selectedOption: matched };
            continue;
          }
          if ((question.options ?? []).length > 0) {
            const fallback = (question.options ?? [])[0]!;
            answers[question.key] = {
              value: fallback.key,
              selectedOption: fallback,
            };
            continue;
          }
          answers[question.key] = { value: response.trim() };
          continue;
        }

        if (question.type === QuestionType.YES_NO) {
          const response = await rl.question("[Y/N]: ");
          const isYes = response.trim().toLowerCase().startsWith("y");
          answers[question.key] = { value: isYes ? AnswerValue.YES : AnswerValue.NO };
          continue;
        }

        if (question.type === QuestionType.CONFIRMATION) {
          const response = await rl.question("[Confirm/cancel]: ");
          const confirmed = response.trim().toLowerCase().startsWith("c");
          answers[question.key] = {
            value: confirmed ? AnswerValue.CONFIRMED : AnswerValue.CANCELLED,
          };
          continue;
        }

        const response = await rl.question("> ");
        answers[question.key] = { value: response.trim(), text: response.trim() };
      }

      return { state: "answered", answers };
    } finally {
      rl.close();
    }
  }
}

function isPromptState(value: unknown): value is HumanPromptState {
  return Boolean(
    value &&
      typeof value === "object" &&
      "state" in (value as Record<string, unknown>),
  );
}

function isAnswerMap(value: unknown): value is HumanPromptAnswerMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return !("value" in (value as Record<string, unknown>));
}
