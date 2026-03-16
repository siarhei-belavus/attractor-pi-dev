import { describe, expect, it } from "vitest";
import { DurableInterviewer } from "../src/server/durable-interviewer.js";
import { QuestionStore } from "../src/server/question-store.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HumanPrompt } from "../src/handlers/types.js";
import type { QuestionRecord } from "../src/server/question-store.js";

function makePrompt(resumeQuestionId?: string): HumanPrompt {
  return {
    title: "Collect input",
    stage: "collect",
    questions: [
      {
        key: "approved",
        text: "Approve?",
        type: "yes_no",
        required: true,
      },
    ],
    metadata: resumeQuestionId ? { resumeQuestionId } : {},
  };
}

describe("DurableInterviewer", () => {
  it("fails fast when resuming with a missing prompt id", async () => {
    const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-interviewer-"));
    try {
      const interviewer = new DurableInterviewer(
        "run-1",
        new QuestionStore(logsRoot),
        { onWaiting() {} },
      );

      await expect(interviewer.ask(makePrompt("q-9999"))).rejects.toThrow(
        "was not found",
      );
    } finally {
      fs.rmSync(logsRoot, { recursive: true, force: true });
    }
  });

  it("fails fast when the resume prompt belongs to a different run", async () => {
    const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-interviewer-"));
    try {
      writeQuestionRecord(logsRoot, {
        id: "q-0001",
        runId: "run-2",
        nodeId: "collect",
        stage: "collect",
        status: "pending",
        prompt: makePrompt("q-0001"),
        answers: null,
        createdAt: new Date(0).toISOString(),
        answeredAt: null,
        metadata: {},
      });

      const interviewer = new DurableInterviewer(
        "run-1",
        new QuestionStore(logsRoot),
        { onWaiting() {} },
      );

      await expect(interviewer.ask(makePrompt("q-0001"))).rejects.toThrow(
        "belongs to run 'run-2'",
      );
    } finally {
      fs.rmSync(logsRoot, { recursive: true, force: true });
    }
  });

  it("fails fast when an answered resume prompt has no stored answers", async () => {
    const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-interviewer-"));
    try {
      writeQuestionRecord(logsRoot, {
        id: "q-0001",
        runId: "run-1",
        nodeId: "collect",
        stage: "collect",
        status: "answered",
        prompt: makePrompt("q-0001"),
        answers: null,
        createdAt: new Date(0).toISOString(),
        answeredAt: new Date(0).toISOString(),
        metadata: {},
      });

      const interviewer = new DurableInterviewer(
        "run-1",
        new QuestionStore(logsRoot),
        { onWaiting() {} },
      );

      await expect(interviewer.ask(makePrompt("q-0001"))).rejects.toThrow(
        "has no stored answers",
      );
    } finally {
      fs.rmSync(logsRoot, { recursive: true, force: true });
    }
  });
});

function writeQuestionRecord(logsRoot: string, record: QuestionRecord): void {
  const questionsDir = path.join(logsRoot, "questions");
  fs.mkdirSync(questionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(questionsDir, `${record.id}.json`),
    JSON.stringify(record, null, 2),
  );
}
