import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { preparePipeline } from "../src/engine/pipeline.js";
import { PipelineRunner } from "../src/engine/runner.js";
import { Checkpoint } from "../src/state/checkpoint.js";
import { StageStatus } from "../src/state/types.js";
import { AutoApproveInterviewer } from "../src/handlers/interviewers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-human-resume-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Integration: wait.human resume", () => {
  it("re-enters the human gate after an aborted checkpoint", async () => {
    const { graph } = preparePipeline(`
      digraph HumanResume {
        graph [goal="Resume a human gate"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        review [shape=hexagon, label="Review release"]
        ship_it [label="Ship it", prompt="Ship the release"]
        rework [label="Rework", prompt="Rework the release"]
        start -> review
        review -> ship_it [label="[A] Approve"]
        review -> rework [label="[R] Rework"]
        ship_it -> exit
        rework -> exit
      }
    `);

    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-human-resume-cp-"));
    new Checkpoint({
      currentNode: "review",
      completedNodes: ["start", "review"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        review: { status: StageStatus.FAIL, failureReason: "AbortError: Aborted with Ctrl+C" },
      },
      context: {
        "graph.goal": "Resume a human gate",
        current_node: "review",
        outcome: "fail",
        "failure.reason": "AbortError: Aborted with Ctrl+C",
      },
      nodeRetries: {},
    }).save(checkpointDir);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
      interviewer: new AutoApproveInterviewer(),
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("outcome")).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("failure.reason")).toBe("");
    expect(result.completedNodes).toContain("ship_it");
    expect(result.completedNodes).toContain("exit");

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });
});
