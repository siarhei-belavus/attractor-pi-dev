import { describe, expect, it } from "vitest";
import { DurableInterviewer } from "../src/server/durable-interviewer.js";
import { QuestionStore } from "../src/server/question-store.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HumanPrompt } from "../src/handlers/types.js";

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
});
