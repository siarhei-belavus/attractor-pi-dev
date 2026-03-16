import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preparePipeline } from "../src/engine/pipeline.js";
import { PipelineRunner } from "../src/engine/runner.js";
import { QueueInterviewer } from "../src/handlers/interviewers.js";
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
});
