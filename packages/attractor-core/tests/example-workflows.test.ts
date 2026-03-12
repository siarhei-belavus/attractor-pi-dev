import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { preparePipeline } from "../src/engine/pipeline.js";
import { Severity } from "../src/validation/index.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("Example workflows", () => {
  it("loads and validates the parallel code review example", () => {
    const dotPath = path.join(repoRoot, "examples/parallel-code-review/pipeline.dot");
    const source = fs.readFileSync(dotPath, "utf-8");

    const { graph, diagnostics } = preparePipeline(source, { dotFilePath: dotPath });
    const errors = diagnostics.filter((diag) => diag.severity === Severity.ERROR);

    expect(graph.id).toBe("ParallelCodeReview");
    expect(graph.nodes.size).toBe(17);
    expect(errors).toEqual([]);
    expect(graph.getNode("review_artifacts").shape).toBe("parallelogram");
    expect(graph.getNode("review_artifacts").attrs["tool_command"]).toContain("git status --short");
    expect(graph.getNode("context_scan").prompt).toContain("artifact packet");
    expect(graph.getNode("context_scan").contextKeys).toEqual([
      "node.review_artifacts.tool.output",
    ]);
    expect(graph.getNode("architecture_review").contextKeys).toEqual([
      "node.context_scan.last_response",
      "node.validate.tool.output",
    ]);
    expect(graph.getNode("merge_findings").contextKeys).toContain(
      "node.architecture_review.last_response",
    );
    expect(graph.getNode("lead_summary").contextKeys).toContain(
      "node.merge_findings.parallel.fan_in.llm_evaluation",
    );
  });
});
