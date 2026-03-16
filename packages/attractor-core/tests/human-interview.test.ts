import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preparePipeline } from "../src/engine/pipeline.js";
import { PipelineRunner } from "../src/engine/runner.js";
import { QueueInterviewer } from "../src/handlers/interviewers.js";
import { HumanInterviewHandler } from "../src/handlers/handlers.js";
import { DurableInterviewer } from "../src/server/durable-interviewer.js";
import { QuestionStore } from "../src/server/question-store.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-human-interview-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Integration: human.interview", () => {
  it("writes normalized flat and node-scoped context values", async () => {
    const { graph } = preparePipeline(`
      digraph HumanInterview {
        graph [goal="Collect deployment parameters"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        collect [
          type="human.interview",
          label="Collect deployment input",
          human.questions="[
            {\\"key\\":\\"approved\\",\\"text\\":\\"Approve deployment?\\",\\"type\\":\\"yes_no\\"},
            {\\"key\\":\\"window\\",\\"text\\":\\"Deployment window\\",\\"type\\":\\"freeform\\",\\"required\\":false},
            {\\"key\\":\\"strategy\\",\\"text\\":\\"Strategy\\",\\"type\\":\\"multiple_choice\\",\\"options\\":[{\\"key\\":\\"rolling\\",\\"label\\":\\"Rolling\\"},{\\"key\\":\\"bluegreen\\",\\"label\\":\\"Blue/Green\\"}]}
          ]"
        ]
        start -> collect -> exit
      }
    `);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      interviewer: new QueueInterviewer([
        {
          approved: { value: "yes" },
          window: { value: "after-hours", text: "after-hours" },
          strategy: { value: "bluegreen" },
        },
      ]),
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.get("human.interview.answers")).toEqual({
      approved: "yes",
      window: "after-hours",
      strategy: "bluegreen",
    });
    expect(result.context.getString("human.interview.approved")).toBe("yes");
    expect(result.context.getString("human.interview.window")).toBe("after-hours");
    expect(result.context.getString("human.interview.strategy")).toBe("bluegreen");
    expect(result.context.getString("human.interview.strategy.label")).toBe("Blue/Green");
    expect(result.context.get("node.collect.human.interview.answers")).toEqual({
      approved: "yes",
      window: "after-hours",
      strategy: "bluegreen",
    });
    expect(result.context.getString("node.collect.human.interview.approved")).toBe("yes");
    expect(result.context.getString("node.collect.human.interview.strategy")).toBe("bluegreen");
  });

  it("fails fast on unexpected answer keys", async () => {
    const { graph } = preparePipeline(`
      digraph HumanInterview {
        graph [goal="Collect deployment parameters"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        collect [
          type="human.interview",
          human.questions="[
            {\\"key\\":\\"approved\\",\\"text\\":\\"Approve deployment?\\",\\"type\\":\\"yes_no\\"}
          ]"
        ]
        start -> collect -> exit
      }
    `);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      interviewer: new QueueInterviewer([
        {
          approved: { value: "yes" },
          rogue: { value: "oops" },
        },
      ]),
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.FAIL);
    expect(result.outcome.failureReason).toContain("unexpected answer key");
  });

  it("loads a canonical prompt from human.prompt_file", async () => {
    const promptPath = path.join(tmpDir, "clarification-prompt.json");
    fs.writeFileSync(
      promptPath,
      JSON.stringify({
        title: "Clarifications",
        stage: "collect",
        questions: [
          {
            key: "approved",
            text: "Approve deployment?",
            type: "yes_no",
            required: true,
          },
        ],
      }),
    );

    const { graph } = preparePipeline(
      `
        digraph HumanInterview {
          graph [goal="Collect deployment parameters"]
          start [shape=Mdiamond]
          exit  [shape=Msquare]
          collect [
            type="human.interview",
            human.prompt_file="${promptPath.replaceAll("\\", "\\\\")}"
          ]
          start -> collect -> exit
        }
      `,
    );

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      interviewer: new QueueInterviewer([{ approved: { value: "yes" } }]),
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("human.interview.approved")).toBe("yes");
  });

  it("validates resumed answers against the persisted prompt instead of a changed prompt file", async () => {
    const promptPath = path.join(tmpDir, "clarification-prompt.json");
    fs.writeFileSync(
      promptPath,
      JSON.stringify({
        title: "Clarifications",
        stage: "collect",
        questions: [
          {
            key: "approved",
            text: "Approve deployment?",
            type: "yes_no",
            required: true,
          },
        ],
      }),
    );

    const { graph } = preparePipeline(
      `
        digraph HumanInterview {
          graph [goal="Collect deployment parameters"]
          start [shape=Mdiamond]
          exit  [shape=Msquare]
          collect [
            type="human.interview",
            human.prompt_file="${promptPath.replaceAll("\\", "\\\\")}"
          ]
          start -> collect -> exit
        }
      `,
    );
    const store = new QuestionStore(tmpDir);
    const pending = store.createPending("run-1", {
      title: "Clarifications",
      stage: "collect",
      questions: [
        {
          key: "approved",
          text: "Approve deployment?",
          type: "yes_no",
          required: true,
        },
      ],
    });
    const submitted = store.submitAnswers("run-1", pending.id, {
      approved: { value: "yes" },
    });
    expect(submitted.ok).toBe(true);

    fs.writeFileSync(
      promptPath,
      JSON.stringify({
        title: "Changed clarifications",
        stage: "collect",
        questions: [
          {
            key: "approved",
            text: "Select approval",
            type: "multiple_choice",
            options: [{ key: "green", label: "Green" }],
            required: true,
          },
        ],
      }),
    );

    const context = new Context();
    context.set("internal.waiting_for_question_id", pending.id);
    const handler = new HumanInterviewHandler(
      new DurableInterviewer("run-1", store, { onWaiting() {} }),
    );

    const outcome = await handler.execute(graph.getNode("collect"), context, graph, tmpDir);

    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.contextUpdates?.["human.interview.approved"]).toBe("yes");
  });
});
