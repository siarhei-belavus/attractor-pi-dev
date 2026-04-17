import path from "node:path";
import { describe, expect, it } from "vitest";
import { preparePipeline } from "../src/engine/pipeline.js";
import { getPreparedWorkflowBaseDir } from "../src/workflow-paths.js";

describe("workflow path contract", () => {
  it("derives workflowBaseDir from dotFilePath and preserves it on the prepared graph", () => {
    const workflowFile = path.join("/tmp", "workflow-space", "graph.dot");
    const { graph } = preparePipeline(
      `
        digraph WorkflowPaths {
          graph [goal="workflow paths"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A", backend_setup="${"${workflow_base_dir}"}/setup.mjs", cwd="${"${run_root}"}/workspace"]
          start -> a -> exit
        }
      `,
      { dotFilePath: workflowFile },
    );

    expect(getPreparedWorkflowBaseDir(graph)).toBe(path.dirname(workflowFile));
  });

  it("accepts cwd expressions from workflow_base_dir and run_root only", () => {
    expect(() =>
      preparePipeline(
        `
          digraph WorkflowPaths {
            graph [goal="workflow paths"]
            start [shape=Mdiamond]
            exit [shape=Msquare]
            a [prompt="Do A", cwd="${"${workflow_base_dir}"}/pkg"]
            start -> a -> exit
          }
        `,
        { workflowBaseDir: "/tmp/workflow-space" },
      ),
    ).not.toThrow();

    expect(() =>
      preparePipeline(
        `
          digraph WorkflowPaths {
            graph [goal="workflow paths"]
            start [shape=Mdiamond]
            exit [shape=Msquare]
            a [prompt="Do A", cwd="${"${run_root}"}/workspace"]
            start -> a -> exit
          }
        `,
      ),
    ).not.toThrow();
  });

  it("rejects bare relative runtime paths", () => {
    expect(() =>
      preparePipeline(`
        digraph WorkflowPaths {
          graph [goal="workflow paths"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A", backend_setup="./setup.mjs"]
          start -> a -> exit
        }
      `),
    ).toThrow(/reserved runtime tokens only/i);

    expect(() =>
      preparePipeline(`
        digraph WorkflowPaths {
          graph [goal="workflow paths"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A", cwd="workspace"]
          start -> a -> exit
        }
      `),
    ).toThrow(/reserved runtime tokens only/i);
  });

  it("fails string workflows that need workflow_base_dir but do not supply it", () => {
    expect(() =>
      preparePipeline(`
        digraph WorkflowPaths {
          graph [goal="workflow paths"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A", backend_setup="${"${workflow_base_dir}"}/setup.mjs"]
          start -> a -> exit
        }
      `),
    ).toThrow(/requires workflow_base_dir/i);
  });

  it("rejects unsupported tokens for backend_setup and cwd", () => {
    expect(() =>
      preparePipeline(`
        digraph WorkflowPaths {
          graph [goal="workflow paths"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A", backend_setup="${"${run_root}"}/setup.mjs"]
          start -> a -> exit
        }
      `),
    ).toThrow(/backend_setup.*workflow_base_dir/i);

    expect(() =>
      preparePipeline(`
        digraph WorkflowPaths {
          graph [goal="workflow paths"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A", cwd="${"${unknown_token}"}/workspace"]
          start -> a -> exit
        }
      `),
    ).toThrow(/reserved runtime tokens only/i);
  });
});
