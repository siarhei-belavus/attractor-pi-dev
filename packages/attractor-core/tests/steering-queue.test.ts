import { describe, expect, it } from "vitest";
import {
  InMemorySteeringQueue,
  createSteeringMessage,
} from "../src/steering/queue.js";

describe("InMemorySteeringQueue", () => {
  it("enqueues and drains matching targets once", () => {
    const queue = new InMemorySteeringQueue();
    queue.enqueue(
      createSteeringMessage({
        target: { runId: "run-1", executionId: "exec-1" },
        message: "First",
        source: "api",
      }),
    );

    expect(queue.peek({ runId: "run-1", executionId: "exec-1" })).toHaveLength(1);
    expect(queue.drain({ runId: "run-1", executionId: "exec-1" })).toMatchObject([
      { message: "First" },
    ]);
    expect(queue.peek({ runId: "run-1", executionId: "exec-1" })).toEqual([]);
  });

  it("filters by branch key without leaking to sibling branches", () => {
    const queue = new InMemorySteeringQueue();
    queue.enqueue(
      createSteeringMessage({
        target: { runId: "run-1", executionId: "exec-1", branchKey: "branch-a" },
        message: "Only branch A",
        source: "manager",
      }),
    );

    expect(
      queue.peek({ runId: "run-1", executionId: "exec-1", branchKey: "branch-b" }),
    ).toEqual([]);
    expect(
      queue.drain({ runId: "run-1", executionId: "exec-1", branchKey: "branch-a" }),
    ).toMatchObject([{ message: "Only branch A" }]);
  });

  it("keeps runs process-local by isolating messages per queue instance", () => {
    const firstQueue = new InMemorySteeringQueue();
    const secondQueue = new InMemorySteeringQueue();
    firstQueue.enqueue(
      createSteeringMessage({
        target: { runId: "run-1" },
        message: "Ephemeral",
        source: "cli",
      }),
    );

    expect(firstQueue.peek({ runId: "run-1" })).toHaveLength(1);
    expect(secondQueue.peek({ runId: "run-1" })).toEqual([]);
  });
});
