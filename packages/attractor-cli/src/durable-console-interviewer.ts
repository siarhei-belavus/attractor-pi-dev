import {
  DurableInterviewer,
  QuestionStore,
  QuestionType,
  type HumanPrompt,
  type HumanPromptState,
  type Interviewer,
} from "@attractor/core";

export class DurableConsoleInterviewer implements Interviewer {
  private readonly durable: DurableInterviewer;

  constructor(
    runId: string,
    logsRoot: string,
  ) {
    const store = new QuestionStore(logsRoot);
    this.durable = new DurableInterviewer(runId, store, {
      onWaiting: (question) => {
        renderPrompt(question.id, question.prompt);
      },
    });
  }

  ask(prompt: HumanPrompt): Promise<HumanPromptState> {
    return this.durable.ask(prompt);
  }
}

function renderPrompt(promptId: string, prompt: HumanPrompt): void {
  console.log("");
  console.log(`Prompt: ${promptId}`);
  console.log(`Stage: ${prompt.stage}`);
  console.log(`Title: ${prompt.title}`);
  for (const question of prompt.questions) {
    console.log(`- ${question.key}: ${question.text}`);
    console.log(`  type: ${question.type}`);
    console.log(`  required: ${question.required !== false ? "true" : "false"}`);
    if (question.type === QuestionType.MULTIPLE_CHOICE) {
      const options = question.options ?? [];
      for (const option of options) {
        console.log(`  option ${option.key}: ${option.label}`);
      }
    }
  }
}
