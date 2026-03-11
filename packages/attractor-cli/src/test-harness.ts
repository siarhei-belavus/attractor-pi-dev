import * as fs from "node:fs";
import * as path from "node:path";
import {
  AnswerValue,
  type Interviewer,
  type Question,
  type ManagerObserverFactory,
  type ObserveResult,
} from "@attractor/core";

export interface CliTestConfig {
  interviewer?: {
    mode: "wait_once";
    questionId?: string;
  };
  managerObserver?: {
    observations: ObserveResult[];
  };
  resumeFrom?: string;
}

interface StoredQuestionRecord {
  id: string;
  runId: string;
  nodeId: string;
  stage: string;
  status: "pending";
  question: Question;
  answer: null;
  createdAt: string;
  answeredAt: null;
  metadata: Record<string, unknown>;
}

const TEST_CONFIG_ENV = "ATTRACTOR_CLI_TEST_CONFIG";

export function loadCliTestConfig(env: NodeJS.ProcessEnv = process.env): CliTestConfig | null {
  const configPath = env[TEST_CONFIG_ENV];
  if (!configPath) {
    return null;
  }

  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as CliTestConfig;
}

export function createTestInterviewer(
  config: CliTestConfig | null,
  logsRoot: string,
  runId: string,
): Interviewer | null {
  if (config?.interviewer?.mode !== "wait_once") {
    return null;
  }

  return new WaitingInterviewer(logsRoot, runId, config.interviewer.questionId ?? "q-0001");
}

export function createTestManagerObserverFactory(
  config: CliTestConfig | null,
): ManagerObserverFactory | undefined {
  const observations = config?.managerObserver?.observations;
  if (!observations || observations.length === 0) {
    return undefined;
  }

  let index = 0;
  return async () => ({
    observe: async () => {
      const observation = observations[Math.min(index, observations.length - 1)]!;
      index++;
      return observation;
    },
  });
}

class WaitingInterviewer implements Interviewer {
  private readonly questionsDir: string;

  constructor(
    private readonly logsRoot: string,
    private readonly runId: string,
    private readonly questionId: string,
  ) {
    this.questionsDir = path.join(logsRoot, "questions");
  }

  async ask(question: Question) {
    fs.mkdirSync(this.questionsDir, { recursive: true });
    const filePath = path.join(this.questionsDir, `${this.questionId}.json`);

    if (!fs.existsSync(filePath)) {
      const record: StoredQuestionRecord = {
        id: this.questionId,
        runId: this.runId,
        nodeId: question.stage,
        stage: question.stage,
        status: "pending",
        question,
        answer: null,
        createdAt: new Date(0).toISOString(),
        answeredAt: null,
        metadata: question.metadata ?? {},
      };
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
    }

    return {
      value: AnswerValue.WAITING,
      questionId: this.questionId,
    };
  }
}

