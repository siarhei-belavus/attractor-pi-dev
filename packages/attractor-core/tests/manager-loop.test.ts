import { describe, it, expect, vi } from "vitest";
import { ManagerLoopHandler } from "../src/handlers/handlers.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import { InMemorySteeringQueue } from "../src/steering/queue.js";
import type { GraphNode } from "../src/model/graph.js";
import type { Graph } from "../src/model/graph.js";
import type { ManagerObserver, ObserveResult } from "../src/handlers/types.js";

/** Helper to create a minimal GraphNode with manager attrs */
function makeManagerNode(
  overrides: Partial<GraphNode> & { attrs?: Record<string, unknown> } = {},
): GraphNode {
  return {
    id: "manager",
    label: "Manager Loop",
    shape: "house",
    type: "stack.manager_loop",
    prompt: "",
    maxRetries: 0,
    goalGate: false,
    retryTarget: "",
    fallbackRetryTarget: "",
    fidelity: "",
    threadId: "",
    classes: [],
    timeout: null,
    llmModel: "",
    llmProvider: "",
    reasoningEffort: "",
    autoStatus: false,
    allowPartial: false,
    attrs: {},
    ...overrides,
  };
}

/** Minimal stub graph (the handler does not use graph methods directly) */
const stubGraph = {} as Graph;
const stubLogsRoot = "/tmp/test-logs";

describe("ManagerLoopHandler", () => {
  describe("without observer", () => {
    it("fails fast when no observer is wired", async () => {
      const handler = new ManagerLoopHandler();
      const node = makeManagerNode({
        attrs: { "manager.max_cycles": "5" },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);
      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toContain("observer wiring is missing");
    });
  });

  describe("child completes successfully within max_cycles", () => {
    it("returns SUCCESS when child reports completed/success on cycle 3", async () => {
      let callCount = 0;
      const observer: ManagerObserver = {
        observe: async (_ctx: Context): Promise<ObserveResult> => {
          callCount++;
          if (callCount >= 3) {
            return { childStatus: "completed", childOutcome: "success" };
          }
          return { childStatus: "running" };
        },
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "10",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.notes).toContain("cycle 3");
      expect(result.contextUpdates).toMatchObject({
        "manager.final_cycle": 3,
        "stack.manager_loop.cycle_count": 3,
        "stack.manager_loop.last_child_status": "completed",
        "stack.manager_loop.last_child_outcome": "success",
        "stack.manager_loop.last_child_lock": "",
      });
      expect(callCount).toBe(3);
    });
  });

  describe("child fails", () => {
    it("returns FAIL when child reports failed status", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "failed",
          childOutcome: "error",
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "10",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toContain("Child failed at cycle 1");
      expect(result.contextUpdates).toMatchObject({
        "manager.final_cycle": 1,
        "stack.manager_loop.last_child_status": "failed",
        "stack.manager_loop.last_child_outcome": "error",
      });
    });
  });

  describe("max_cycles exhausted", () => {
    it("returns FAIL when max_cycles is reached without completion", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "running",
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "3",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toBe("Max cycles exceeded");
      expect(result.notes).toContain("exhausted 3 cycles");
      expect(result.contextUpdates).toMatchObject({
        "manager.final_cycle": 3,
        "stack.manager_loop.cycle_count": 3,
      });
    });

    it("defaults max_cycles to 1000 when not specified", async () => {
      let cyclesSeen = 0;
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => {
          cyclesSeen++;
          // Complete after 2 cycles so the test doesn't actually run 1000 times
          if (cyclesSeen >= 2) {
            return { childStatus: "completed", childOutcome: "success" };
          }
          return { childStatus: "running" };
        },
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: { "manager.actions": "observe" },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(cyclesSeen).toBe(2);
    });
  });

  describe("stop_condition evaluation", () => {
    it("returns SUCCESS when stop_condition is satisfied", async () => {
      let cycle = 0;
      const observer: ManagerObserver = {
        observe: async (ctx: Context): Promise<ObserveResult> => {
          cycle++;
          // On cycle 2, set a context value that satisfies the stop condition
          if (cycle >= 2) {
            ctx.set("quality_score", "high");
          }
          return { childStatus: "running" };
        },
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "10",
          "manager.actions": "observe",
          "manager.stop_condition": "quality_score=high",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.notes).toContain("Stop condition satisfied at cycle 2");
    });

    it("does not trigger stop_condition when it is not satisfied", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "running",
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "3",
          "manager.actions": "observe",
          "manager.stop_condition": "quality_score=high",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toBe("Max cycles exceeded");
    });
  });

  describe("observe action", () => {
    it("writes child telemetry into context", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "completed",
          childOutcome: "success",
          telemetry: {
            stages_completed: 5,
            current_stage: "build",
          },
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "5",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(ctx.getString("stack.child.status")).toBe("completed");
      expect(ctx.getString("stack.child.outcome")).toBe("success");
      expect(ctx.get("stack.child.telemetry.stages_completed")).toBe(5);
      expect(ctx.get("stack.child.telemetry.current_stage")).toBe("build");
      expect(ctx.getString("stack.manager_loop.last_child_status")).toBe("completed");
    });

    it("skips observe when not in actions list", async () => {
      const observeSpy = vi.fn<() => Promise<ObserveResult>>().mockResolvedValue({
        childStatus: "running",
      });
      const observer: ManagerObserver = {
        observe: observeSpy,
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "2",
          "manager.actions": "wait",
          "manager.poll_interval": "1ms",
        },
      });
      const ctx = new Context();
      // Set child status to completed so the loop terminates (since observe isn't called
      // to set it, the child status stays empty and the loop runs to max_cycles)
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(observeSpy).not.toHaveBeenCalled();
      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toBe("Max cycles exceeded");
    });
  });

  describe("steer action", () => {
    it("enqueues steering when steer is in actions", async () => {
      let observeCalls = 0;
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => {
          observeCalls++;
          if (observeCalls >= 2) {
            return { childStatus: "completed", childOutcome: "success" };
          }
          return { childStatus: "running" };
        },
      };

      const steeringQueue = new InMemorySteeringQueue();
      const handler = new ManagerLoopHandler(steeringQueue);
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "5",
          "manager.actions": "observe,steer",
          "manager.steer_cooldown_ms": "0",
          "manager.steering_message": "Focus on tests",
        },
      });
      const ctx = Context.fromSnapshot({
        "internal.run_id": "run-1",
        "internal.last_completed_execution_id": "child-thread",
        "internal.last_completed_node_id": "child",
      });
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(
        steeringQueue.peek({
          runId: "run-1",
          executionId: "child-thread",
          nodeId: "child",
        }),
      ).toMatchObject([
        {
          message: "Focus on tests",
          source: "manager",
        },
      ]);
    });

    it("does not enqueue steering when not in actions", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "completed",
          childOutcome: "success",
        }),
      };

      const steeringQueue = new InMemorySteeringQueue();
      const handler = new ManagerLoopHandler(steeringQueue);
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "5",
          "manager.actions": "observe",
        },
      });
      const ctx = Context.fromSnapshot({
        "internal.run_id": "run-1",
        "internal.last_completed_execution_id": "child-thread",
      });
      await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(
        steeringQueue.peek({
          runId: "run-1",
          executionId: "child-thread",
          nodeId: "child",
        }),
      ).toEqual([]);
    });
  });

  describe("cycle tracking in context", () => {
    it("sets manager.current_cycle on each iteration", async () => {
      const cycleValues: number[] = [];
      const observer: ManagerObserver = {
        observe: async (ctx: Context): Promise<ObserveResult> => {
          cycleValues.push(ctx.getNumber("manager.current_cycle"));
          if (cycleValues.length >= 3) {
            return { childStatus: "completed", childOutcome: "success" };
          }
          return { childStatus: "running" };
        },
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "10",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(cycleValues).toEqual([1, 2, 3]);
    });
  });

  describe("poll_interval with wait action", () => {
    it("does not wait on the last cycle (max_cycles reached)", async () => {
      const start = Date.now();
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "running",
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "2",
          "manager.actions": "observe,wait",
          "manager.poll_interval": "10ms",
        },
      });
      const ctx = new Context();
      await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      const elapsed = Date.now() - start;
      // Should wait once (between cycle 1 and 2), not on the last cycle
      // Allow generous timing tolerance for CI environments
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("child completed with non-success outcome", () => {
    it("returns SUCCESS only when childOutcome is success", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "completed",
          childOutcome: "partial",
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "3",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.PARTIAL_SUCCESS);
      expect(result.contextUpdates).toMatchObject({
        "manager.final_cycle": 1,
        "stack.manager_loop.last_child_outcome": "partial",
      });
    });
  });

  describe("supervision semantics", () => {
    it("records lock decisions from observer snapshots", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "completed",
          childOutcome: "success",
          childLockDecision: "resolved",
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "3",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.contextUpdates).toMatchObject({
        "stack.manager_loop.last_child_lock": "resolved",
        "stack.manager_loop.lock_decision": "resolved",
      });
      expect(ctx.getString("stack.child.lock_decision")).toBe("resolved");
    });

    it("fails when the child requests reopen", async () => {
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => ({
          childStatus: "completed",
          childOutcome: "success",
          childLockDecision: "reopen",
        }),
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "3",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toBe("Child requested reopen");
    });

    it("clears stale optional observe fields when omitted", async () => {
      let cycle = 0;
      const observer: ManagerObserver = {
        observe: async (): Promise<ObserveResult> => {
          cycle++;
          if (cycle === 1) {
            return {
              childStatus: "running",
              childOutcome: "success",
              childLockDecision: "resolved",
            };
          }
          return {
            childStatus: "completed",
          };
        },
      };

      const handler = new ManagerLoopHandler();
      handler.setObserver(observer);
      const node = makeManagerNode({
        attrs: {
          "manager.max_cycles": "3",
          "manager.actions": "observe",
        },
      });
      const ctx = new Context();
      const result = await handler.execute(node, ctx, stubGraph, stubLogsRoot);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.contextUpdates).toMatchObject({
        "stack.manager_loop.last_child_status": "completed",
        "stack.manager_loop.last_child_outcome": "",
        "stack.manager_loop.last_child_lock": "",
      });
      expect(ctx.getString("stack.child.outcome")).toBe("");
      expect(ctx.getString("stack.child.lock_decision")).toBe("");
    });
  });
});
