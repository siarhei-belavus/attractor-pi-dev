import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { preparePipeline, parseAndBuild } from "../src/engine/pipeline.js";
import { PipelineRunner } from "../src/engine/runner.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import { InMemorySteeringQueue } from "../src/steering/queue.js";
import { validate, Severity } from "../src/validation/index.js";
import type { PipelineEvent } from "../src/events/index.js";
import { AutoApproveInterviewer, QueueInterviewer } from "../src/handlers/interviewers.js";
import type { Answer, ManagerObserverFactory } from "../src/handlers/types.js";
import { Checkpoint } from "../src/state/checkpoint.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Integration: preparePipeline", () => {
  it("parses, transforms, and validates a simple pipeline", () => {
    const { graph, diagnostics } = preparePipeline(`
      digraph Simple {
        graph [goal="Run tests and report"]
        start [shape=Mdiamond, label="Start"]
        exit  [shape=Msquare, label="Exit"]
        run_tests [label="Run Tests", prompt="Run the test suite for: $goal"]
        report    [label="Report", prompt="Summarize results"]
        start -> run_tests -> report -> exit
      }
    `);

    expect(graph.id).toBe("Simple");
    expect(graph.nodes.size).toBe(4);
    // $goal should be expanded
    expect(graph.getNode("run_tests").prompt).toBe(
      "Run the test suite for: Run tests and report",
    );
    const errors = diagnostics.filter((d) => d.severity === Severity.ERROR);
    expect(errors.length).toBe(0);
  });
});

describe("Integration: PipelineRunner", () => {
  it("runs a simple linear pipeline in simulate mode", async () => {
    const { graph } = preparePipeline(`
      digraph Simple {
        graph [goal="Run tests"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        run_tests [label="Run Tests", prompt="Run tests"]
        report    [label="Report", prompt="Summarize"]
        start -> run_tests -> report -> exit
      }
    `);

    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("run_tests");
    expect(result.completedNodes).toContain("report");

    // Check events were emitted
    expect(events.some((e) => e.type === "pipeline_started")).toBe(true);
    expect(events.some((e) => e.type === "pipeline_completed")).toBe(true);
    expect(events.some((e) => e.type === "stage_started")).toBe(true);
    expect(events.some((e) => e.type === "checkpoint_saved")).toBe(true);

    // Check artifacts exist
    expect(
      fs.existsSync(path.join(tmpDir, "run_tests", "prompt.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "run_tests", "response.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "run_tests", "status.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "checkpoint.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "manifest.json"))).toBe(true);
  });

  it("runs conditional branching pipeline", async () => {
    const { graph } = preparePipeline(`
      digraph Branch {
        graph [goal="Implement and validate"]
        node [shape=box]
        start     [shape=Mdiamond]
        exit      [shape=Msquare]
        plan      [label="Plan", prompt="Plan it"]
        implement [label="Implement", prompt="Build it"]
        validate  [label="Validate", prompt="Test it"]
        gate      [shape=diamond, label="Tests passing?"]
        start -> plan -> implement -> validate -> gate
        gate -> exit      [label="Yes", condition="outcome=success"]
        gate -> implement [label="No", condition="outcome!=success"]
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // In simulation mode, all stages return SUCCESS, so gate -> exit
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("plan");
    expect(result.completedNodes).toContain("implement");
    expect(result.completedNodes).toContain("validate");
    expect(result.completedNodes).toContain("gate");
  });

  it("handles human gate with auto-approve", async () => {
    const { graph } = preparePipeline(`
      digraph Review {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        review [shape=hexagon, label="Review Changes"]
        ship_it [label="Ship It", prompt="Deploy"]
        fixes [label="Fix Issues", prompt="Fix"]
        start -> review
        review -> ship_it [label="[A] Approve"]
        review -> fixes [label="[F] Fix"]
        ship_it -> exit
        fixes -> review
      }
    `);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      interviewer: new AutoApproveInterviewer(),
    });
    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("review");
    expect(result.completedNodes).toContain("ship_it");
  });

  it("context updates from one node are visible to the next", async () => {
    const { graph } = preparePipeline(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        b [prompt="Do B"]
        start -> a -> b -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // After a runs, context should have last_stage set
    expect(result.context.getString("last_stage")).toBe("b");
    expect(result.context.getString("graph.goal")).toBe("");
  });

  it("fails exit when a declared goal gate was never visited", async () => {
    const { graph } = preparePipeline(`
      digraph MissingGoalGate {
        graph [goal="test"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        chooser [shape=diamond, label="Choose path"]
        happy_path [prompt="Happy path"]
        must_run [prompt="Required work", goal_gate=true]
        start -> chooser
        chooser -> happy_path [weight=10]
        chooser -> must_run [weight=5]
        happy_path -> exit
        must_run -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.FAIL);
    expect(result.outcome.failureReason).toBe("Goal gate unsatisfied and no retry target");
    expect(result.completedNodes).toContain("happy_path");
    expect(result.completedNodes).not.toContain("must_run");
  });

  it("routes to retry_target when exit sees an unvisited goal gate", async () => {
    const { graph } = preparePipeline(`
      digraph MissingGoalGateRetry {
        graph [goal="test"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        chooser [shape=diamond, label="Choose path"]
        happy_path [prompt="Happy path"]
        must_run [prompt="Required work", goal_gate=true, retry_target="must_run"]
        start -> chooser
        chooser -> happy_path [weight=10]
        chooser -> must_run [weight=5]
        happy_path -> exit
        must_run -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("happy_path");
    expect(result.completedNodes).toContain("must_run");
  });

  it("edge selection: weight breaks ties for unconditional edges", async () => {
    const { graph } = preparePipeline(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        gate [shape=diamond]
        a [prompt="A"]
        b [prompt="B"]
        start -> gate
        gate -> a [weight=10]
        gate -> b [weight=5]
        a -> exit
        b -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // Should route through 'a' (higher weight)
    expect(result.completedNodes).toContain("a");
    expect(result.completedNodes).not.toContain("b");
  });

  it("custom handler registration and execution", async () => {
    const { graph } = preparePipeline(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="my_custom", label="Custom"]
        start -> a -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("my_custom", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return {
          status: StageStatus.SUCCESS,
          notes: `Custom handler ran for ${node.id}`,
          contextUpdates: { "custom.ran": "true" },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("custom.ran")).toBe("true");
  });

  it("routes judge.rubric through confidence.gate into conditional", async () => {
    const { graph } = preparePipeline(`
      digraph JudgeConfidence {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        judge [type="judge.rubric", prompt="Evaluate", judge.input_key="artifact.body", judge.threshold="0.8"]
        confidence [type="confidence.gate", confidence.threshold="0.8"]
        route [shape=diamond, label="Route"]
        auto [prompt="Ship it"]
        human [prompt="Escalate"]
        start -> judge -> confidence -> route
        route -> auto [condition="confidence.gate.decision=autonomous"]
        route -> human [condition="confidence.gate.decision=escalate"]
        auto -> exit
        human -> exit
      }
    `);

    const ctx = new Context();
    ctx.set("artifact.body", "Candidate implementation");

    const result = await new PipelineRunner({
      logsRoot: tmpDir,
      backend: {
        async run(node) {
          if (node.id === "judge") {
            return JSON.stringify({ score: 0.93, summary: "Approved" });
          }
          return "ok";
        },
      },
    }).run(graph, ctx);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("auto");
    expect(result.completedNodes).not.toContain("human");
    expect(result.context.getString("confidence.gate.decision")).toBe("autonomous");
  });

  it("routes failure.analyze into conditional", async () => {
    const { graph } = preparePipeline(`
      digraph FailureAnalyzeRoute {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        failing [type="fail_stage"]
        analyze [type="failure.analyze", prompt="Classify failure"]
        route [shape=diamond, label="Route"]
        retry [prompt="Retry it"]
        escalate [prompt="Escalate it"]
        start -> failing
        failing -> analyze [condition="outcome=fail"]
        route -> retry [condition="failure.analyze.class=transient"]
        route -> escalate [condition="failure.analyze.class!=transient"]
        analyze -> route
        retry -> exit
        escalate -> exit
      }
    `);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      backend: {
        async run(node) {
          if (node.id === "analyze") {
            return JSON.stringify({
              class: "transient",
              summary: "Temporary outage",
              recommendation: "Retry later",
            });
          }
          return "ok";
        },
      },
    });
    runner.registerHandler("fail_stage", {
      async execute() {
        return {
          status: StageStatus.FAIL,
          failureReason: "HTTP 503 from upstream",
        };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("failure.reason")).toBe("HTTP 503 from upstream");
    expect(result.completedNodes).toContain("retry");
    expect(result.completedNodes).not.toContain("escalate");
    expect(result.context.getString("failure.analyze.class")).toBe("transient");
  });

  it("routes quality.gate into conditional", async () => {
    const { graph } = preparePipeline(`
      digraph QualityGateRoute {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        seed [type="seed_quality"]
        quality [type="quality.gate", quality.checks="[{\\\"label\\\":\\\"tests\\\",\\\"condition\\\":\\\"tests.pass=true\\\"},{\\\"label\\\":\\\"lint\\\",\\\"condition\\\":\\\"lint.pass=true\\\"}]"]
        route [shape=diamond, label="Route"]
        continue_path [prompt="Continue"]
        fix_path [prompt="Fix issues"]
        start -> seed -> quality -> route
        route -> continue_path [condition="quality.gate.result=pass"]
        route -> fix_path [condition="quality.gate.result=fail"]
        continue_path -> exit
        fix_path -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("seed_quality", {
      async execute() {
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: {
            "tests.pass": "true",
            "lint.pass": "false",
          },
        };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("fix_path");
    expect(result.completedNodes).not.toContain("continue_path");
    expect(result.context.getString("quality.gate.result")).toBe("fail");
  });

  it("wires manager loop observers through PipelineRunner", async () => {
    const { graph } = preparePipeline(`
      digraph ManagerLoop {
        graph [goal="Supervise child", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        child [label="Child", prompt="Do the work", thread_id="child-thread"]
        manager [shape=house, label="Manager"]
        start -> child -> manager -> exit
      }
    `);
    graph.getNode("manager").attrs["manager.actions"] = "observe";
    graph.getNode("manager").attrs["manager.max_cycles"] = "2";

    let seenBindingKey = "";
    const managerObserverFactory: ManagerObserverFactory = async ({ context }) => {
      seenBindingKey = context.getString("internal.last_completed_thread_key");
      return {
        observe: async () => ({
          childStatus: "completed",
          childOutcome: "success",
          telemetry: { observed_execution_ref: seenBindingKey },
        }),
      };
    };

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      managerObserverFactory,
    });

    const context = new Context();
    context.set("internal.last_completed_backend_execution_ref", "backend-child-ref");
    const result = await runner.run(graph, context);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(seenBindingKey).toBe("child-thread");
    expect(result.context.getString("stack.child.telemetry.observed_execution_ref")).toBe(
      "child-thread",
    );
  });

  it("starts and supervises a child pipeline from stack.child_dotfile", async () => {
    const childDotfile = path.join(tmpDir, "child.dot");
    fs.writeFileSync(
      childDotfile,
      `
        digraph ChildPipeline {
          graph [goal="Run child work"]
          start [shape=Mdiamond]
          exit  [shape=Msquare]
          child_work [label="Child Work", prompt="Finish the child task"]
          start -> child_work -> exit
        }
      `,
    );

    const { graph } = preparePipeline(`
      digraph ManagerStartsChild {
        graph [goal="Supervise child pipeline", stack.child_dotfile="${childDotfile}"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        manager [shape=house, label="Manager"]
        start -> manager -> exit
      }
    `);
    graph.getNode("manager").attrs["manager.actions"] = "observe,wait";
    graph.getNode("manager").attrs["manager.max_cycles"] = "20";
    graph.getNode("manager").attrs["manager.poll_interval"] = "1ms";

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("stack.manager_loop.child.id")).toBe(
      `${path.basename(tmpDir)}:manager:child`,
    );
    expect(result.context.getString("stack.manager_loop.child.run_id")).toBe(
      `${path.basename(tmpDir)}:manager:child-run`,
    );
    expect(result.context.getString("stack.child.status")).toBe("completed");
    expect(result.context.getString("stack.child.outcome")).toBe("success");
  });

  it("attaches to an existing child execution when stack.child_autostart is disabled", async () => {
    const { graph } = preparePipeline(`
      digraph ManagerAttachesChild {
        graph [goal="Attach to child", stack.child_autostart="false"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        child [label="Child", prompt="Do the work", thread_id="child-thread"]
        manager [shape=house, label="Manager"]
        start -> child -> manager -> exit
      }
    `);
    graph.getNode("manager").attrs["manager.actions"] = "observe";
    graph.getNode("manager").attrs["manager.max_cycles"] = "1";

    let seenChildExecution: Record<string, unknown> | null = null;
    const managerObserverFactory: ManagerObserverFactory = async ({ childExecution }) => {
      seenChildExecution = childExecution as unknown as Record<string, unknown>;
      return {
        observe: async () => ({
          childStatus: "completed",
          childOutcome: "success",
        }),
      };
    };

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      managerObserverFactory,
    });

    const context = new Context();
    context.set("internal.last_completed_backend_execution_ref", "backend-child-ref");
    const result = await runner.run(graph, context);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(seenChildExecution).toMatchObject({
      id: `${path.basename(tmpDir)}:manager:attached-child`,
      runId: path.basename(tmpDir),
      kind: "attached_backend_execution",
      autostart: false,
      attachedTarget: {
        backendExecutionRef: "backend-child-ref",
        nodeId: "child",
      },
    });
  });

  it("covers the manager observe/steer lifecycle end-to-end", async () => {
    const { graph } = preparePipeline(`
      digraph ManagerLoopLifecycle {
        graph [goal="Supervise child lifecycle", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        child [label="Child", prompt="Do the work", thread_id="child-thread"]
        manager [shape=house, label="Manager", manager.steering_message="Focus on finishing cleanly"]
        start -> child -> manager -> exit
      }
    `);
    graph.getNode("manager").attrs["manager.actions"] = "observe,steer";
    graph.getNode("manager").attrs["manager.max_cycles"] = "3";
    graph.getNode("manager").attrs["manager.steer_cooldown_ms"] = "0";

    const steeringQueue = new InMemorySteeringQueue();
    let observeCalls = 0;
    const managerObserverFactory: ManagerObserverFactory = async () => ({
      observe: async () => {
        observeCalls++;
        if (observeCalls === 1) {
          return {
            childStatus: "running",
            telemetry: { lifecycle_state: "awaiting_input", observed_execution_ref: "child-thread" },
          };
        }
        return {
          childStatus: "completed",
          childOutcome: "success",
          childLockDecision: "resolved",
          telemetry: { lifecycle_state: "completed", observed_execution_ref: "child-thread" },
        };
      },
    });

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      managerObserverFactory,
      steeringQueue,
    });

    const context = new Context();
    context.set("internal.last_completed_backend_execution_ref", "backend-child-ref");
    const result = await runner.run(graph, context);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(observeCalls).toBe(2);
    expect(
      steeringQueue.peek({
        runId: path.basename(tmpDir),
        childExecutionId: `${path.basename(tmpDir)}:manager:attached-child`,
      }),
    ).toMatchObject([
      {
        message: "Focus on finishing cleanly",
        source: "manager",
      },
    ]);
    expect(result.context.getString("stack.manager_loop.last_child_status")).toBe("completed");
    expect(result.context.getString("stack.manager_loop.lock_decision")).toBe("resolved");
  });

  it("clears stale child outcome and lock state between manager observations", async () => {
    const { graph } = preparePipeline(`
      digraph ManagerLoopClearsStaleState {
        graph [goal="Supervise child lifecycle", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        child [label="Child", prompt="Do the work", thread_id="child-thread"]
        manager [shape=house, label="Manager"]
        start -> child -> manager -> exit
      }
    `);
    graph.getNode("manager").attrs["manager.actions"] = "observe";
    graph.getNode("manager").attrs["manager.max_cycles"] = "1";

    const managerObserverFactory: ManagerObserverFactory = async () => ({
      observe: async () => ({
        childStatus: "completed",
      }),
    });

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      managerObserverFactory,
    });

    const initialContext = new Context();
    initialContext.set("internal.last_completed_backend_execution_ref", "backend-child-ref");
    initialContext.set("stack.child.outcome", "success");
    initialContext.set("stack.child.lock_decision", "reopen");
    const result = await runner.run(graph, initialContext);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("stack.child.outcome")).toBe("");
    expect(result.context.getString("stack.child.lock_decision")).toBe("");
    expect(result.context.getString("stack.manager_loop.last_child_outcome")).toBe("");
    expect(result.context.getString("stack.manager_loop.last_child_lock")).toBe("");
  });

  it("fails manager loop execution when observer wiring is missing", async () => {
    const { graph } = preparePipeline(`
      digraph ManagerLoopMissingObserver {
        graph [goal="Supervise child", stack.child_autostart="false"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        child [label="Child", prompt="Do the work"]
        manager [shape=house, label="Manager"]
        start -> child -> manager -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const context = new Context();
    context.set("internal.last_completed_backend_execution_ref", "backend-child-ref");
    const result = await runner.run(graph, context);

    expect(result.outcome.status).toBe(StageStatus.FAIL);
    expect(result.outcome.failureReason).toContain("unsupported");
  });

  it("variable expansion ($goal) works", () => {
    const { graph } = preparePipeline(`
      digraph G {
        graph [goal="Build the widget"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan how to: $goal"]
        start -> plan -> exit
      }
    `);
    expect(graph.getNode("plan").prompt).toBe("Plan how to: Build the widget");
  });

  it("pipeline with 10+ nodes completes without errors", async () => {
    const { graph } = preparePipeline(`
      digraph Large {
        graph [goal="Build a large pipeline"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        n1 [prompt="Step 1"]
        n2 [prompt="Step 2"]
        n3 [prompt="Step 3"]
        n4 [prompt="Step 4"]
        n5 [prompt="Step 5"]
        n6 [prompt="Step 6"]
        n7 [prompt="Step 7"]
        n8 [prompt="Step 8"]
        n9 [prompt="Step 9"]
        n10 [prompt="Step 10"]
        start -> n1 -> n2 -> n3 -> n4 -> n5 -> n6 -> n7 -> n8 -> n9 -> n10 -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes.length).toBe(12); // start + 10 nodes + exit
  });
});

describe("Integration: loop_restart edge attribute", () => {
  it("resets retry counters when loop_restart edge is taken", async () => {
    // Pipeline: start -> work -> gate -> exit (on success)
    //                                  -> work [loop_restart=true] (on fail)
    // "work" node uses a custom handler that:
    //   - Sets a retry counter in context on first visit per loop
    //   - Uses max_retries=2 so the internal retry counter is meaningful
    const { graph } = preparePipeline(`
      digraph LoopTest {
        graph [goal="Test loop restart"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        work  [type="counting_handler", prompt="Do work", max_retries=1]
        gate  [shape=diamond, label="Check"]
        start -> work -> gate
        gate -> exit [condition="outcome=success"]
        gate -> work [condition="outcome!=success", loop_restart=true]
      }
    `);

    // Track how many times "work" has been executed across loop iterations
    let workExecutionCount = 0;

    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    // Custom handler that:
    //  1st call: sets a retry counter in context, returns SUCCESS
    //  (gate is conditional handler: returns SUCCESS in simulate)
    //  gate -> exit path taken on success
    // We need gate to return FAIL first time to trigger the loop_restart
    // Actually, the conditional handler just returns SUCCESS always.
    // We need to control the gate outcome directly.

    // Better approach: use a custom handler for gate too
    runner.registerHandler("counting_handler", {
      async execute(node, ctx, _graph, _logsRoot) {
        workExecutionCount++;
        // Record the retry counter value at the time of execution
        const retryKey = `internal.retry_count.${node.id}`;
        const currentRetryCount = ctx.getNumber(retryKey);
        ctx.set(`test.retry_count_at_exec_${workExecutionCount}`, currentRetryCount);
        ctx.set("test.work_exec_count", workExecutionCount);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    // For gate: first time return FAIL to trigger loop, second time return SUCCESS
    let gateCallCount = 0;
    runner.registerHandler("conditional", {
      async execute(node, ctx, _graph, _logsRoot) {
        gateCallCount++;
        if (gateCallCount === 1) {
          return {
            status: StageStatus.FAIL,
            contextUpdates: { last_stage: node.id },
          };
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    // Pipeline should complete successfully (gate succeeds second time)
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // work should have been executed twice (once per loop iteration)
    expect(workExecutionCount).toBe(2);

    // The retry counter for "work" should have been 0 on the second
    // execution, proving it was reset by loop_restart
    expect(result.context.getNumber("test.retry_count_at_exec_1")).toBe(0);
    expect(result.context.getNumber("test.retry_count_at_exec_2")).toBe(0);

    // A loop_restarted event should have been emitted
    const loopEvents = events.filter((e) => e.type === "loop_restarted");
    expect(loopEvents.length).toBe(1);
    const loopEvent = loopEvents[0] as { type: "loop_restarted"; fromNode: string; toNode: string };
    expect(loopEvent.fromNode).toBe("gate");
    expect(loopEvent.toNode).toBe("work");
  });

  it("clears nodeOutcomes for reachable nodes on loop_restart", async () => {
    // Pipeline: start -> a -> b -> gate -> exit (success)
    //                                    -> a [loop_restart=true] (fail)
    // Verify that on loop restart, nodeOutcomes for a and b are cleared
    const { graph } = preparePipeline(`
      digraph LoopClear {
        graph [goal="Test outcome clearing"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="track_handler", prompt="A"]
        b [type="track_handler", prompt="B"]
        gate [shape=diamond]
        start -> a -> b -> gate
        gate -> exit [condition="outcome=success"]
        gate -> a    [condition="outcome!=success", loop_restart=true]
      }
    `);

    const execOrder: string[] = [];
    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    runner.registerHandler("track_handler", {
      async execute(node, _ctx, _graph, _logsRoot) {
        execOrder.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    let gateCount = 0;
    runner.registerHandler("conditional", {
      async execute(node, _ctx, _graph, _logsRoot) {
        gateCount++;
        execOrder.push(node.id);
        if (gateCount === 1) {
          return {
            status: StageStatus.FAIL,
            contextUpdates: { last_stage: node.id },
          };
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // Execution order: a, b, gate (fail), a, b, gate (success)
    expect(execOrder).toEqual(["a", "b", "gate", "a", "b", "gate"]);

    // Verify loop_restarted event
    expect(events.some((e) => e.type === "loop_restarted")).toBe(true);
  });

  it("re-runs goal gates after loop_restart clears their outcomes", async () => {
    const { graph } = preparePipeline(`
      digraph LoopRestartGoalGate {
        graph [goal="Retry required work"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        goal [type="goal_tracker", prompt="Required work", goal_gate=true]
        gate [shape=diamond]
        start -> goal -> gate
        gate -> exit [condition="outcome=success"]
        gate -> goal [condition="outcome!=success", loop_restart=true]
      }
    `);

    const goalVisits: number[] = [];
    let goalExecutionCount = 0;
    let gateCount = 0;
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("goal_tracker", {
      async execute(node, ctx, _graph, _logsRoot) {
        goalExecutionCount++;
        goalVisits.push(goalExecutionCount);
        ctx.set("test.goal_execution_count", goalExecutionCount);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    runner.registerHandler("conditional", {
      async execute(node, _ctx, _graph, _logsRoot) {
        gateCount++;
        if (gateCount === 1) {
          return {
            status: StageStatus.FAIL,
            contextUpdates: { last_stage: node.id },
          };
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(goalVisits).toEqual([1, 2]);
    expect(result.context.getNumber("test.goal_execution_count")).toBe(2);
  });

  it("does not reset retry counters when loop_restart is false", async () => {
    // Same structure but without loop_restart: counters should persist
    const { graph } = preparePipeline(`
      digraph NoLoopRestart {
        graph [goal="Test no reset"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        work  [type="retry_tracker", prompt="Do work", max_retries=1]
        gate  [shape=diamond]
        start -> work -> gate
        gate -> exit [condition="outcome=success"]
        gate -> work [condition="outcome!=success"]
      }
    `);

    let workCount = 0;
    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    runner.registerHandler("retry_tracker", {
      async execute(node, ctx, _graph, _logsRoot) {
        workCount++;
        // Set a retry counter manually to simulate previous retries
        const retryKey = `internal.retry_count.${node.id}`;
        if (workCount === 1) {
          ctx.set(retryKey, 3); // Simulate 3 retries from first iteration
        }
        ctx.set(`test.retry_at_work_${workCount}`, ctx.getNumber(retryKey));
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    let gateCount = 0;
    runner.registerHandler("conditional", {
      async execute(node, _ctx, _graph, _logsRoot) {
        gateCount++;
        if (gateCount === 1) {
          return {
            status: StageStatus.FAIL,
            contextUpdates: { last_stage: node.id },
          };
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // On first visit: handler sets retry counter to 3, then reads it back as 3
    expect(result.context.getNumber("test.retry_at_work_1")).toBe(3);
    // On second visit: retry counter should still be 3 (not reset, since loop_restart=false)
    expect(result.context.getNumber("test.retry_at_work_2")).toBe(3);

    // No loop_restarted event should exist
    const loopEvents = events.filter((e) => e.type === "loop_restarted");
    expect(loopEvents.length).toBe(0);
  });
});

describe("Integration: Smoke Test (spec 11.13)", () => {
  it("runs the spec integration smoke test pipeline", async () => {
    const DOT = `
      digraph test_pipeline {
        graph [goal="Create a hello world Python script"]
        start       [shape=Mdiamond]
        plan        [shape=box, prompt="Plan how to create a hello world script for: $goal"]
        implement   [shape=box, prompt="Write the code based on the plan", goal_gate=true]
        review      [shape=box, prompt="Review the code for correctness"]
        done        [shape=Msquare]
        start -> plan
        plan -> implement
        implement -> review [condition="outcome=success"]
        implement -> plan   [condition="outcome=fail", label="Retry"]
        review -> done      [condition="outcome=success"]
        review -> implement [condition="outcome=fail", label="Fix"]
      }
    `;

    // 1. Parse
    const { graph, diagnostics } = preparePipeline(DOT);
    expect(graph.attrs.goal).toBe("Create a hello world Python script");
    expect(graph.nodes.size).toBe(5);
    expect(graph.edges.length).toBe(6);

    // 2. Validate
    const errors = diagnostics.filter((d) => d.severity === Severity.ERROR);
    expect(errors.length).toBe(0);

    // 3. Execute with simulation (no LLM)
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // 4. Verify
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("implement");

    // 5. Verify artifacts for all LLM nodes
    for (const nodeName of ["plan", "implement", "review"]) {
      expect(
        fs.existsSync(path.join(tmpDir, nodeName, "prompt.md")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, nodeName, "response.md")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, nodeName, "status.json")),
      ).toBe(true);
    }

    // 5b. Verify goal gate satisfied (implement has goal_gate=true)
    const implementStatus = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "implement", "status.json"), "utf-8"),
    );
    expect(implementStatus.outcome).toBe("success");

    // 6. Verify checkpoint
    expect(fs.existsSync(path.join(tmpDir, "checkpoint.json"))).toBe(true);
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "checkpoint.json"), "utf-8"),
    );
    expect(checkpoint.currentNode).toBe("done");
    expect(checkpoint.completedNodes).toContain("plan");
    expect(checkpoint.completedNodes).toContain("implement");
    expect(checkpoint.completedNodes).toContain("review");
  });
});

describe("Integration: Checkpoint Resume", () => {
  it("checkpoint preserves nodeOutcomes", async () => {
    const DOT = `
      digraph PreserveOutcomes {
        graph [goal="Preserve outcomes"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="partial_handler", prompt="Run A"]
        start -> a -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("partial_handler", {
      async execute() {
        return {
          status: StageStatus.PARTIAL_SUCCESS,
          notes: "accepted partial",
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);

    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "checkpoint.json"), "utf-8"),
    ) as {
      nodeOutcomes: Record<string, { status: string }>;
    };
    expect(checkpoint.nodeOutcomes.start.status).toBe(StageStatus.SUCCESS);
    expect(checkpoint.nodeOutcomes.a.status).toBe(StageStatus.PARTIAL_SUCCESS);
  });

  it("resume uses restored last outcome for edge selection", async () => {
    const DOT = `
      digraph ResumeSelect {
        graph [goal="Resume edge selection"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        chooser [type="manual_gate", prompt="Choose"]
        success_path [type="track_path", prompt="Success path"]
        fail_path [type="track_path", prompt="Fail path"]
        start -> chooser
        chooser -> success_path [condition="outcome=success"]
        chooser -> fail_path [condition="outcome=fail"]
        success_path -> exit
        fail_path -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-outcome-"));
    new Checkpoint({
      currentNode: "chooser",
      completedNodes: ["start", "chooser"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        chooser: { status: StageStatus.FAIL, failureReason: "gate failed" },
      },
      nodeRetries: {},
      context: { "graph.goal": "Resume edge selection", outcome: "fail" },
    }).save(checkpointDir);

    const executed: string[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });
    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["fail_path"]);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("resumes a pipeline from a checkpoint, skipping already-completed nodes", async () => {
    // Pipeline: start -> a -> b -> c -> exit
    // We'll run it fully first, create a checkpoint after "a",
    // then resume from that checkpoint with a new runner.
    const DOT = `
      digraph Resume {
        graph [goal="Test resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="tracking", prompt="Do A"]
        b [type="tracking", prompt="Do B"]
        c [type="tracking", prompt="Do C"]
        start -> a -> b -> c -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Create a checkpoint as if we completed start and a
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cp-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        a: { status: StageStatus.SUCCESS },
      },
      context: { "graph.goal": "Test resume", last_stage: "a", outcome: "success" },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    // Now resume from the checkpoint
    const executedNodes: string[] = [];
    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
      onEvent: (e) => events.push(e),
    });
    runner.registerHandler("tracking", {
      async execute(node, ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    // Should succeed
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Only b and c should have been actually executed (start and a were skipped)
    expect(executedNodes).toEqual(["b", "c"]);

    // completedNodes should include all nodes (restored + newly executed)
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("a");
    expect(result.completedNodes).toContain("b");
    expect(result.completedNodes).toContain("c");

    // A checkpoint_resumed event should have been emitted
    const resumeEvents = events.filter((e) => e.type === "checkpoint_resumed");
    expect(resumeEvents.length).toBe(1);
    const resumeEvent = resumeEvents[0] as {
      type: "checkpoint_resumed";
      resumedFromNode: string;
      skippedNodes: string[];
    };
    expect(resumeEvent.resumedFromNode).toBe("a");
    expect(resumeEvent.skippedNodes).toEqual(["start", "a"]);

    // Clean up checkpoint dir
    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("preserves context values across checkpoint/resume", async () => {
    const DOT = `
      digraph CtxResume {
        graph [goal="Test context resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="ctx_setter", prompt="Set context"]
        b [type="ctx_reader", prompt="Read context"]
        start -> a -> b -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Create a checkpoint after "a" with custom context values
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-resume-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        a: { status: StageStatus.SUCCESS },
      },
      context: {
        "graph.goal": "Test context resume",
        outcome: "success",
        "custom.key1": "hello",
        "custom.key2": 42,
        last_stage: "a",
      },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    let capturedCtx: Record<string, unknown> = {};
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    runner.registerHandler("ctx_setter", {
      async execute(node, ctx, _graph, _logsRoot) {
        // Should not run since "a" was already completed
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("ctx_reader", {
      async execute(node, ctx, _graph, _logsRoot) {
        // Capture context values that were restored from checkpoint
        capturedCtx = {
          key1: ctx.getString("custom.key1"),
          key2: ctx.getNumber("custom.key2"),
          lastStage: ctx.getString("last_stage"),
        };
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Context from checkpoint should have been visible to node b
    expect(capturedCtx.key1).toBe("hello");
    expect(capturedCtx.key2).toBe(42);
    expect(capturedCtx.lastStage).toBe("a");

    // Final context should have the updated last_stage from b
    expect(result.context.getString("last_stage")).toBe("b");

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("restores retry counters from checkpoint", async () => {
    const DOT = `
      digraph RetryResume {
        graph [goal="Test retry resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="retry_check", prompt="A"]
        b [type="retry_check", prompt="B"]
        start -> a -> b -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Create a checkpoint after "a" with retry counters
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-resume-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        a: { status: StageStatus.SUCCESS },
      },
      context: {
        "graph.goal": "Test retry resume",
        outcome: "success",
        last_stage: "a",
        "internal.retry_count.a": 3,
      },
      nodeRetries: { a: 3 },
    });
    cp.save(checkpointDir);

    let retryCountAtB = -1;
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    runner.registerHandler("retry_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        if (node.id === "b") {
          // Check that retry counter for "a" was restored
          retryCountAtB = ctx.getNumber("internal.retry_count.a");
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // The retry counter for "a" should have been restored from the checkpoint
    expect(retryCountAtB).toBe(3);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("handles resume when checkpoint directory has no checkpoint file", async () => {
    const DOT = `
      digraph NoCheckpoint {
        graph [goal="Test no checkpoint"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        start -> a -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Point to an empty directory (no checkpoint.json)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-cp-"));

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: emptyDir,
    });

    // Should run normally from the start since no checkpoint exists
    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("a");

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("resumed pipeline saves new checkpoints as it progresses", async () => {
    const DOT = `
      digraph SaveOnResume {
        graph [goal="Test checkpoint saves on resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="simple", prompt="A"]
        b [type="simple", prompt="B"]
        c [type="simple", prompt="C"]
        start -> a -> b -> c -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Checkpoint after "a"
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "save-resume-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        a: { status: StageStatus.SUCCESS },
      },
      context: { "graph.goal": "Test checkpoint saves on resume", outcome: "success", last_stage: "a" },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    runner.registerHandler("simple", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // The new logsRoot (tmpDir) should have a checkpoint.json reflecting the final state
    expect(fs.existsSync(path.join(tmpDir, "checkpoint.json"))).toBe(true);
    const finalCheckpoint = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "checkpoint.json"), "utf-8"),
    );
    // Last completed node should be "exit" (terminal node is now included in checkpoint)
    expect(finalCheckpoint.currentNode).toBe("exit");
    expect(finalCheckpoint.completedNodes).toContain("start");
    expect(finalCheckpoint.completedNodes).toContain("a");
    expect(finalCheckpoint.completedNodes).toContain("b");
    expect(finalCheckpoint.completedNodes).toContain("c");
    expect(finalCheckpoint.nodeOutcomes?.a?.status).toBe(StageStatus.SUCCESS);
    expect(finalCheckpoint.nodeOutcomes?.b?.status).toBe(StageStatus.SUCCESS);
    expect(finalCheckpoint.nodeOutcomes?.c?.status).toBe(StageStatus.SUCCESS);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("preserves failed and partial goal_gate semantics after resume", async () => {
    const DOT = `
      digraph GoalGateResume {
        graph [goal="Test gate semantics on resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        gate [type="manual_gate", goal_gate=true, prompt="Gate node"]
        start -> gate -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const failCpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fail-resume-"));
    new Checkpoint({
      currentNode: "gate",
      completedNodes: ["start", "gate"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        gate: { status: StageStatus.FAIL, failureReason: "failed before checkpoint" },
      },
      context: { "graph.goal": "Test gate semantics on resume", outcome: "fail", last_stage: "gate" },
      nodeRetries: {},
    }).save(failCpDir);

    const failRunner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: failCpDir,
    });
    const failResult = await failRunner.run(graph);
    expect(failResult.outcome.status).toBe(StageStatus.FAIL);

    const partialCpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-partial-resume-"));
    new Checkpoint({
      currentNode: "gate",
      completedNodes: ["start", "gate"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        gate: { status: StageStatus.PARTIAL_SUCCESS, notes: "good enough" },
      },
      context: { "graph.goal": "Test gate semantics on resume", outcome: "partial_success", last_stage: "gate" },
      nodeRetries: {},
    }).save(partialCpDir);

    const partialRunner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: partialCpDir,
    });
    const partialResult = await partialRunner.run(graph);
    expect(partialResult.outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);

    fs.rmSync(failCpDir, { recursive: true, force: true });
    fs.rmSync(partialCpDir, { recursive: true, force: true });
  });

  it("fails resumed exit when a declared goal_gate has no outcome", async () => {
    const DOT = `
      digraph ResumeMissingGoalGate {
        graph [goal="Resume into exit with skipped goal gate"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        chooser [shape=diamond]
        happy_path [prompt="Happy path"]
        must_run [prompt="Required work", goal_gate=true]
        start -> chooser
        chooser -> happy_path [weight=10]
        chooser -> must_run [weight=5]
        happy_path -> exit
        must_run -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-gate-missing-resume-"));
    new Checkpoint({
      currentNode: "happy_path",
      completedNodes: ["start", "chooser", "happy_path"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        chooser: { status: StageStatus.SUCCESS },
        happy_path: { status: StageStatus.SUCCESS },
      },
      context: {
        "graph.goal": "Resume into exit with skipped goal gate",
        outcome: "success",
        last_stage: "happy_path",
      },
      nodeRetries: {},
    }).save(checkpointDir);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.FAIL);
    expect(result.outcome.failureReason).toBe("Goal gate unsatisfied and no retry target");
    expect(result.completedNodes).toEqual(["start", "chooser", "happy_path"]);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("preserves preferredLabel-based routing after resume", async () => {
    const DOT = `
      digraph PreferredLabelResume {
        graph [goal="Test preferred label resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        chooser [type="branch_track", prompt="Choose branch"]
        left [type="branch_track", prompt="Left branch"]
        right [type="branch_track", prompt="Right branch"]
        start -> chooser
        chooser -> left [label="Go left"]
        chooser -> right [label="Go right"]
        left -> exit
        right -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "preferred-resume-"));
    new Checkpoint({
      currentNode: "chooser",
      completedNodes: ["start", "chooser"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        chooser: { status: StageStatus.SUCCESS, preferredLabel: "Go right" },
      },
      context: { "graph.goal": "Test preferred label resume", outcome: "success", last_stage: "chooser" },
      nodeRetries: {},
    }).save(checkpointDir);

    const executedNodes: string[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });
    runner.registerHandler("branch_track", {
      async execute(node, _ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executedNodes).toEqual(["right"]);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("preserves suggestedNextIds-based routing after resume", async () => {
    const DOT = `
      digraph SuggestedIdsResume {
        graph [goal="Test suggested ids resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        chooser [type="branch_track", prompt="Choose branch"]
        left [type="branch_track", prompt="Left branch"]
        right [type="branch_track", prompt="Right branch"]
        start -> chooser
        chooser -> left
        chooser -> right
        left -> exit
        right -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "suggested-resume-"));
    new Checkpoint({
      currentNode: "chooser",
      completedNodes: ["start", "chooser"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        chooser: { status: StageStatus.SUCCESS, suggestedNextIds: ["right"] },
      },
      context: { "graph.goal": "Test suggested ids resume", outcome: "success", last_stage: "chooser" },
      nodeRetries: {},
    }).save(checkpointDir);

    const executedNodes: string[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });
    runner.registerHandler("branch_track", {
      async execute(node, _ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executedNodes).toEqual(["right"]);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });
});

describe("Integration: Pipeline Variables", () => {
  it("expands declared variables with defaults", () => {
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test vars", vars="feature=login, priority=high"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan the $feature feature at $priority priority"]
        start -> plan -> exit
      }
    `);
    expect(graph.getNode("plan").prompt).toBe(
      "Plan the login feature at high priority",
    );
  });

  it("overrides defaults with --set variables", () => {
    const { graph } = preparePipeline(
      `
      digraph Vars {
        graph [goal="Test vars", vars="feature=login, priority=high"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan the $feature feature at $priority priority"]
        start -> plan -> exit
      }
    `,
      { variables: { feature: "auth", priority: "low" } },
    );
    expect(graph.getNode("plan").prompt).toBe(
      "Plan the auth feature at low priority",
    );
  });

  it("$goal is implicitly declared from graph[goal]", () => {
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Build a widget", vars="feature"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Goal: $goal, feature: $feature"]
        start -> plan -> exit
      }
    `, { variables: { feature: "search" } });
    expect(graph.getNode("plan").prompt).toBe(
      "Goal: Build a widget, feature: search",
    );
  });

  it("--set goal overrides graph[goal] in prompts", () => {
    const { graph } = preparePipeline(
      `
      digraph Vars {
        graph [goal="Original goal", vars="feature=x"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="$goal with $feature"]
        start -> plan -> exit
      }
    `,
      { variables: { goal: "Overridden goal" } },
    );
    expect(graph.getNode("plan").prompt).toBe(
      "Overridden goal with x",
    );
  });

  it("validation catches undeclared variables", () => {
    expect(() =>
      preparePipeline(`
        digraph Vars {
          graph [goal="Test", vars="feature"]
          start [shape=Mdiamond]
          exit  [shape=Msquare]
          plan [prompt="Plan $feature with $unknown_var"]
          start -> plan -> exit
        }
      `, { variables: { feature: "login" } }),
    ).toThrow(/vars_declared/);
  });

  it("skips variable validation when no vars declared (backward compat)", () => {
    // No vars attribute at all — $anything in prompts is left as-is, no error
    const { graph } = preparePipeline(`
      digraph Legacy {
        graph [goal="Test legacy"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan $goal with $something"]
        start -> plan -> exit
      }
    `);
    // $goal gets expanded (implicitly declared via graph[goal]), $something left as-is
    expect(graph.getNode("plan").prompt).toBe(
      "Plan Test legacy with $something",
    );
  });

  it("expands variables in labels too", () => {
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test", vars="env=prod"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        deploy [label="Deploy to $env", prompt="Deploy"]
        start -> deploy -> exit
      }
    `);
    expect(graph.getNode("deploy").label).toBe("Deploy to prod");
  });

  it("vars without defaults require --set values", () => {
    // feature has no default, so $feature won't expand unless --set provides it
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test", vars="feature"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan $feature"]
        start -> plan -> exit
      }
    `, { variables: { feature: "notifications" } });
    expect(graph.getNode("plan").prompt).toBe("Plan notifications");
  });

  it("unresolved vars without --set are left as-is in prompt", () => {
    // feature declared but no default and no --set value
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test", vars="feature"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan $feature"]
        start -> plan -> exit
      }
    `);
    // Variable is declared but not resolved — left as $feature
    expect(graph.getNode("plan").prompt).toBe("Plan $feature");
  });
});

describe("Integration: Preamble Transform (spec §9.2)", () => {
  it("prepends preamble when fidelity is compact", async () => {
    const { graph } = preparePipeline(`
      digraph PreambleTest {
        graph [goal="Test preamble", default_fidelity="compact"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="ctx_setter", prompt="Do A"]
        b [type="prompt_capture", prompt="Do B"]
        start -> a -> b -> exit
      }
    `);

    let capturedPrompt = "";
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("ctx_setter", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { "project.name": "Widget", last_stage: node.id },
        };
      },
    });

    runner.registerHandler("prompt_capture", {
      async execute(node, _ctx, _graph, logsRoot) {
        // Read the prompt file that the CodergenHandler would have written
        // Since we override the handler, we need a different approach.
        // Instead, use the default codergen handler and capture the prompt from logs.
        return { status: StageStatus.SUCCESS };
      },
    });

    // Use a custom backend to capture the prompt as seen by the LLM
    const result = await new PipelineRunner({
      logsRoot: tmpDir,
      backend: {
        async run(_node, prompt, _context) {
          capturedPrompt = prompt;
          return "ok";
        },
      },
    }).run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // The prompt for node "b" should contain a preamble with context
    expect(capturedPrompt).toContain("Context from previous stages");
    expect(capturedPrompt).toContain("Do B");
  });

  it("does not prepend preamble when fidelity is full", async () => {
    const { graph } = preparePipeline(`
      digraph NoPreamble {
        graph [goal="Test no preamble", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        b [prompt="Do B"]
        start -> a -> b -> exit
      }
    `);

    const prompts: string[] = [];
    const result = await new PipelineRunner({
      logsRoot: tmpDir,
      backend: {
        async run(_node, prompt, _context) {
          prompts.push(prompt);
          return "ok";
        },
      },
    }).run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // With full fidelity, no preamble should be prepended
    const lastPrompt = prompts[prompts.length - 1]!;
    expect(lastPrompt).not.toContain("Context from previous stages");
  });

  it("preamble content reflects fidelity-filtered snapshot", async () => {
    const { graph } = preparePipeline(`
      digraph PreambleContent {
        graph [goal="Test preamble content", default_fidelity="compact"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        b [prompt="Do B"]
        start -> a -> b -> exit
      }
    `);

    let capturedPrompt = "";
    const result = await new PipelineRunner({
      logsRoot: tmpDir,
      backend: {
        async run(node, prompt, _context) {
          if (node.id === "b") capturedPrompt = prompt;
          return "ok";
        },
      },
    }).run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // Compact mode filters out internal.* keys — preamble should not contain them
    expect(capturedPrompt).toContain("Context from previous stages");
    expect(capturedPrompt).not.toContain("internal.");
  });
});

describe("Integration: Fan-in LLM evaluation (spec §4.9)", () => {
  it("calls backend when fan-in node has a prompt", async () => {
    const { graph } = preparePipeline(`
      digraph FanInLLM {
        graph [goal="Test fan-in LLM eval"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="succeed", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In", prompt="Evaluate which branch produced better results"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    let fanInPrompt = "";
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      backend: {
        async run(node, prompt, _context) {
          if (node.id === "fan_in") {
            fanInPrompt = prompt;
            return "Candidate 1 is best";
          }
          return "ok";
        },
      },
    });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS, notes: "Branch succeeded" };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // The backend should have been called for the fan-in node
    expect(fanInPrompt).toContain("Evaluate which branch produced better results");
    expect(fanInPrompt).toContain("Candidates");
    expect(fanInPrompt).toContain("Candidate 1");
    expect(fanInPrompt).toContain("Candidate 2");
    // LLM evaluation result should be in context
    expect(result.context.getString("parallel.fan_in.llm_evaluation")).toBe(
      "Candidate 1 is best",
    );
  });

  it("uses heuristic when fan-in node has no prompt", async () => {
    const { graph } = preparePipeline(`
      digraph FanInHeuristic {
        graph [goal="Test fan-in heuristic"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    let backendCalledForFanIn = false;
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      backend: {
        async run(node, _prompt, _context) {
          if (node.id === "fan_in") backendCalledForFanIn = true;
          return "ok";
        },
      },
    });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // Backend should NOT have been called for the fan-in node (no prompt)
    expect(backendCalledForFanIn).toBe(false);
    // Heuristic should have picked the SUCCESS candidate
    expect(result.context.getString("parallel.fan_in.best_outcome")).toBe("success");
  });
});

describe("Integration: Retry on failure (spec §4.5 / 11.12)", () => {
  it("retries a node that returns RETRY up to max_retries times then succeeds", async () => {
    const { graph } = preparePipeline(`
      digraph RetryTest {
        graph [goal="Test retry"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        flaky [type="flaky_handler", prompt="Flaky work", max_retries=2]
        start -> flaky -> exit
      }
    `);

    let attempts = 0;
    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    runner.registerHandler("flaky_handler", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        attempts++;
        if (attempts < 3) {
          return { status: StageStatus.RETRY, notes: `attempt ${attempts} failed` };
        }
        return { status: StageStatus.SUCCESS, notes: "finally succeeded" };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(attempts).toBe(3); // 1 initial + 2 retries

    // stage_retrying events should have been emitted for the two retries
    const retryEvents = events.filter((e) => e.type === "stage_retrying");
    expect(retryEvents.length).toBe(2);
  });

  it("fails after exhausting max_retries", async () => {
    const { graph } = preparePipeline(`
      digraph RetryExhaust {
        graph [goal="Test retry exhaustion"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_retry", prompt="Always fails", max_retries=2]
        start -> broken -> exit
      }
    `);

    let attempts = 0;
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_retry", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        attempts++;
        return { status: StageStatus.RETRY, notes: `attempt ${attempts}` };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.FAIL);
    expect(attempts).toBe(3); // 1 initial + 2 retries, all exhausted
  });

  it("keeps explicit fail-edge routing ahead of retry_target recovery", async () => {
    const { graph } = preparePipeline(`
      digraph FailEdgeWins {
        graph [goal="Prefer fail edge"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_fail", prompt="Always fail", retry_target="retry_path"]
        fail_path [type="track_path", prompt="Fail path"]
        retry_path [type="track_path", prompt="Retry path"]
        start -> broken
        broken -> fail_path [condition="outcome=fail"]
        broken -> retry_path [condition="outcome=success"]
        fail_path -> exit
        retry_path -> exit
      }
    `);

    const executed: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["fail_path"]);
    expect(result.completedNodes).not.toContain("retry_path");
  });

  it("routes node failures to node.retry_target when no fail-edge matches", async () => {
    const { graph } = preparePipeline(`
      digraph NodeRetryTarget {
        graph [goal="Node retry target"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_fail", prompt="Always fail", retry_target="retry_path"]
        retry_path [type="track_path", prompt="Retry path"]
        start -> broken
        broken -> retry_path [condition="outcome=success"]
        retry_path -> exit
      }
    `);

    const executed: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["retry_path"]);
  });

  it("prefers retry_target over unconditional edges after failure", async () => {
    const { graph } = preparePipeline(`
      digraph RetryTargetBeforeCatchAll {
        graph [goal="Retry target before catch-all"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_fail", prompt="Always fail", retry_target="retry_path"]
        catch_all [type="track_path", prompt="Catch-all path"]
        retry_path [type="track_path", prompt="Retry path"]
        start -> broken
        broken -> catch_all
        broken -> retry_path [condition="outcome=success"]
        catch_all -> exit
        retry_path -> exit
      }
    `);

    const executed: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["retry_path"]);
    expect(result.completedNodes).not.toContain("catch_all");
  });

  it("falls back to node.fallback_retry_target when node.retry_target is invalid", async () => {
    const { graph } = preparePipeline(`
      digraph NodeFallbackRetryTarget {
        graph [goal="Node fallback retry target"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [
          type="always_fail",
          prompt="Always fail",
          retry_target="missing_node",
          fallback_retry_target="retry_path"
        ]
        retry_path [type="track_path", prompt="Retry path"]
        start -> broken
        broken -> retry_path [condition="outcome=success"]
        retry_path -> exit
      }
    `);

    const executed: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["retry_path"]);
  });

  it("falls back to graph.retry_target when node-level targets are absent", async () => {
    const { graph } = preparePipeline(`
      digraph GraphRetryTarget {
        graph [goal="Graph retry target", retry_target="graph_retry"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_fail", prompt="Always fail"]
        graph_retry [type="track_path", prompt="Graph retry path"]
        start -> broken
        broken -> graph_retry [condition="outcome=success"]
        graph_retry -> exit
      }
    `);

    const executed: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["graph_retry"]);
  });

  it("falls back to graph.fallback_retry_target when graph.retry_target is invalid", async () => {
    const { graph } = preparePipeline(`
      digraph GraphFallbackRetryTarget {
        graph [
          goal="Graph fallback retry target",
          retry_target="missing_node",
          fallback_retry_target="graph_fallback"
        ]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_fail", prompt="Always fail"]
        graph_fallback [type="track_path", prompt="Graph fallback path"]
        start -> broken
        broken -> graph_fallback [condition="outcome=success"]
        graph_fallback -> exit
      }
    `);

    const executed: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["graph_fallback"]);
  });

  it("keeps terminal failure when no fail-edge or retry target exists", async () => {
    const { graph } = preparePipeline(`
      digraph NoRecoveryTarget {
        graph [goal="No recovery target"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_fail", prompt="Always fail"]
        start -> broken [condition="outcome=success"]
        start -> exit [condition="outcome=fail"]
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.FAIL);
    expect(result.outcome.failureReason).toBe("boom");
  });

  it("resumes failure recovery through retry_target after a checkpoint", async () => {
    const DOT = `
      digraph ResumeRetryTarget {
        graph [goal="Resume retry target"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        broken [type="always_fail", prompt="Always fail", retry_target="retry_path"]
        retry_path [type="track_path", prompt="Retry path"]
        start -> broken
        broken -> retry_path [condition="outcome=success"]
        retry_path -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-retry-target-"));
    new Checkpoint({
      currentNode: "broken",
      completedNodes: ["start", "broken"],
      nodeOutcomes: {
        start: { status: StageStatus.SUCCESS },
        broken: { status: StageStatus.FAIL, failureReason: "boom" },
      },
      context: { "graph.goal": "Resume retry target", outcome: "fail" },
      nodeRetries: {},
    }).save(checkpointDir);

    const executed: string[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    runner.registerHandler("always_fail", {
      async execute() {
        return { status: StageStatus.FAIL, failureReason: "boom" };
      },
    });

    runner.registerHandler("track_path", {
      async execute(node) {
        executed.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(executed).toEqual(["retry_path"]);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });
});

describe("Integration: Stylesheet model override (spec §8 / 11.12)", () => {
  it("applies model override to nodes by shape via stylesheet", () => {
    const { graph } = preparePipeline(`
      digraph StyleTest {
        graph [
          goal="Test stylesheet"
          model_stylesheet="box { llm_model: claude-sonnet; llm_provider: anthropic; }"
        ]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [shape=box, prompt="Do A"]
        start -> a -> exit
      }
    `);

    const nodeA = graph.getNode("a");
    expect(nodeA.llmModel).toBe("claude-sonnet");
    expect(nodeA.llmProvider).toBe("anthropic");
  });

  it("explicit node attribute overrides stylesheet", () => {
    const { graph } = preparePipeline(`
      digraph StyleOverride {
        graph [
          goal="Test override"
          model_stylesheet="box { llm_model: claude-sonnet; }"
        ]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [shape=box, prompt="Do A", llm_model="gpt-4o"]
        start -> a -> exit
      }
    `);

    // Explicit attribute wins over stylesheet
    expect(graph.getNode("a").llmModel).toBe("gpt-4o");
  });
});
