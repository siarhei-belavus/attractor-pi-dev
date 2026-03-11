import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphNode } from "../model/graph.js";
import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";
import { StageStatus, successOutcome, failOutcome } from "../state/types.js";
import { applyFidelity, resolveEffectiveFidelity } from "../state/fidelity.js";
import {
  createSteeringMessage,
  InMemorySteeringQueue,
  type SteeringQueue,
} from "../steering/queue.js";
import {
  applyManagerChildExecution,
  createManagerChildExecution,
  getManagerChildExecution,
  getManagerChildSteeringTarget,
} from "../manager/child-execution.js";
import type {
  Handler,
  CodergenBackend,
  Interviewer,
  QuestionOption,
  ManagerObserver,
  ManagerObserverFactory,
  ManagerChildRuntimeFactory,
} from "./types.js";
import { QuestionType, AnswerValue } from "./types.js";
import { evaluateCondition } from "../conditions/index.js";
import { parseDuration } from "../model/types.js";
import { sleep } from "../engine/retry.js";

/** Start handler: no-op, returns SUCCESS */
export class StartHandler implements Handler {
  async execute(): Promise<Outcome> {
    return successOutcome();
  }
}

/** Exit handler: no-op, returns SUCCESS */
export class ExitHandler implements Handler {
  async execute(): Promise<Outcome> {
    return successOutcome();
  }
}

/** Conditional handler: pass-through, engine evaluates edge conditions */
export class ConditionalHandler implements Handler {
  async execute(node: GraphNode): Promise<Outcome> {
    return successOutcome({ notes: `Conditional node evaluated: ${node.id}` });
  }
}

/** Codergen (LLM) handler */
export class CodergenHandler implements Handler {
  constructor(private backend: CodergenBackend | null = null) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    // 1. Build prompt
    let prompt = node.prompt || node.label;
    prompt = prompt.replaceAll("$goal", graph.attrs.goal);

    // 2. Write original prompt to logs
    const stageDir = path.join(logsRoot, node.id);
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, "prompt.md"), prompt);

    // 3. Build fidelity-filtered context for the LLM backend
    // Edge fidelity is stored in context by the runner before handler execution
    const edgeFidelity = context.getString("internal.incoming_edge_fidelity");
    const fidelityMode = resolveEffectiveFidelity(
      edgeFidelity,
      node.fidelity,
      graph.attrs.defaultFidelity,
    );
    const filteredSnapshot = applyFidelity(context.snapshot(), fidelityMode);
    const filteredContext = context.clone();
    // Replace the cloned context's values with the fidelity-filtered snapshot
    for (const key of Object.keys(filteredContext.snapshot())) {
      filteredContext.delete(key);
    }
    filteredContext.applyUpdates(filteredSnapshot);

    // 4. Preamble synthesis (spec §9.2): when fidelity is not "full", prepend
    //    a text summary of the filtered context so the LLM has enough context
    //    to continue work without full conversation history.
    if (fidelityMode !== "full") {
      const preamble = synthesizePreamble(filteredSnapshot);
      if (preamble) {
        prompt = preamble + "\n\n" + prompt;
      }
    }

    // 5. Call LLM backend
    let responseText: string;
    if (this.backend) {
      try {
        const result = await this.backend.run(node, prompt, filteredContext);
        if (typeof result === "object" && "status" in result) {
          writeStatus(stageDir, result as Outcome);
          return result as Outcome;
        }
        responseText = String(result);
      } catch (err) {
        return failOutcome(String(err));
      }
    } else {
      responseText = `[Simulated] Response for stage: ${node.id}`;
    }

    // 6. Write response to logs
    fs.writeFileSync(path.join(stageDir, "response.md"), responseText);

    // 7. Return outcome
    const outcome: Outcome = {
      status: StageStatus.SUCCESS,
      notes: `Stage completed: ${node.id}`,
      contextUpdates: {
        last_stage: node.id,
        last_response: responseText.slice(0, 200),
      },
    };
    writeStatus(stageDir, outcome);
    return outcome;
  }
}

/** Wait for human handler */
export class WaitForHumanHandler implements Handler {
  constructor(private interviewer: Interviewer) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const edges = graph.outgoingEdges(node.id);
    const choices: Array<{ key: string; label: string; to: string }> = [];

    for (const edge of edges) {
      const label = edge.label || edge.toNode;
      const key = parseAcceleratorKey(label);
      choices.push({ key, label, to: edge.toNode });
    }

    if (choices.length === 0) {
      return failOutcome("No outgoing edges for human gate");
    }

    const options: QuestionOption[] = choices.map((c) => ({
      key: c.key,
      label: c.label,
    }));

    const answer = await this.interviewer.ask({
      text: node.label || "Select an option:",
      type: QuestionType.MULTIPLE_CHOICE,
      options,
      stage: node.id,
      metadata: {
        resumeQuestionId: context.getString("internal.waiting_for_question_id"),
      },
    });

    if (answer.value === AnswerValue.WAITING) {
      return {
        status: StageStatus.WAITING,
        notes: "waiting for human answer",
        contextUpdates: {
          ...(answer.questionId
            ? {
              "internal.waiting_for_question_id": answer.questionId,
              "human.gate.question_id": answer.questionId,
            }
            : {}),
        },
      };
    }

    // Handle timeout
    if (answer.value === AnswerValue.TIMEOUT) {
      const defaultChoice = node.attrs["human.default_choice"] as string | undefined;
      if (defaultChoice) {
        const found = choices.find((c) => c.key === defaultChoice || c.to === defaultChoice);
        if (found) {
          return successOutcome({
            suggestedNextIds: [found.to],
            contextUpdates: {
              "human.gate.selected": found.key,
              "human.gate.label": found.label,
              "internal.waiting_for_question_id": "",
            },
          });
        }
      }
      return {
        status: StageStatus.RETRY,
        failureReason: "human gate timeout, no default",
        contextUpdates: {
          "internal.waiting_for_question_id": "",
        },
      };
    }

    if (answer.value === AnswerValue.SKIPPED) {
      return failOutcome("human skipped interaction", {
        contextUpdates: {
          "internal.waiting_for_question_id": "",
        },
      });
    }

    // Find matching choice
    const selected =
      choices.find(
        (c) =>
          c.key.toLowerCase() === String(answer.value).toLowerCase() ||
          c.label.toLowerCase() === String(answer.value).toLowerCase(),
      ) || choices[0]!;

    return successOutcome({
      suggestedNextIds: [selected.to],
      contextUpdates: {
        "human.gate.selected": selected.key,
        "human.gate.label": selected.label,
        "internal.waiting_for_question_id": "",
        ...(answer.questionId
          ? { "human.gate.question_id": answer.questionId }
          : {}),
      },
    });
  }
}

/** Parallel fan-out handler */
export class ParallelHandler implements Handler {
  private executeSubgraph?: (
    startNodeId: string,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ) => Promise<Outcome>;

  setSubgraphExecutor(
    fn: (
      startNodeId: string,
      context: Context,
      graph: Graph,
      logsRoot: string,
    ) => Promise<Outcome>,
  ): void {
    this.executeSubgraph = fn;
  }

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const branches = graph.outgoingEdges(node.id);
    const joinPolicy = (node.attrs["join_policy"] as string) || "wait_all";
    const errorPolicy = (node.attrs["error_policy"] as string) || "continue";
    const maxParallel = parseInt(String(node.attrs["max_parallel"] ?? "4"), 10);

    if (!this.executeSubgraph) {
      // Fallback: just mark success
      return successOutcome({ notes: "Parallel handler (no subgraph executor)" });
    }

    // Execute branches with bounded parallelism and error policy.
    // On resume from WAITING, reuse prior non-waiting outcomes and rerun only
    // branches that were waiting.
    let results: Outcome[];
    const resumeResults = this.readResumableResults(context, branches.length);
    if (resumeResults) {
      const waitingIndexes = resumeResults
        .map((result, index) => ({ result, index }))
        .filter((entry) => entry.result.status === StageStatus.WAITING)
        .map((entry) => entry.index);

      if (waitingIndexes.length > 0) {
        const rerunMap = await this.executeBranchSubset(
          waitingIndexes,
          branches,
          context,
          graph,
          logsRoot,
          maxParallel,
          errorPolicy,
        );
        results = [...resumeResults];
        for (const waitingIndex of waitingIndexes) {
          const rerun = rerunMap.get(waitingIndex);
          results[waitingIndex] = rerun ?? failOutcome("Branch rerun did not produce an outcome");
        }
      } else {
        results = resumeResults;
      }
    } else {
      results = await this.executeBranches(
        branches,
        context,
        graph,
        logsRoot,
        maxParallel,
        errorPolicy,
      );
    }

    // For "ignore" error policy, filter out failed results for counting purposes
    const countableResults =
      errorPolicy === "ignore"
        ? results.filter((r) => r.status !== StageStatus.FAIL)
        : results;

    const successCount = countableResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    const failCount = countableResults.filter(
      (r) => r.status === StageStatus.FAIL,
    ).length;
    const waitingCount = countableResults.filter(
      (r) => r.status === StageStatus.WAITING,
    ).length;

    context.set("parallel.results", JSON.stringify(results));

    // Evaluate join policy
    if (joinPolicy === "first_success") {
      if (successCount > 0) {
        return successOutcome({
          notes: `${successCount}/${results.length} branches succeeded`,
        });
      }
      if (waitingCount > 0) {
        return {
          status: StageStatus.WAITING,
          notes: `${waitingCount}/${results.length} branches are waiting for input`,
        };
      }
      return failOutcome("All branches failed");
    }

    if (joinPolicy === "k_of_n") {
      const k = parseInt(String(node.attrs["join_k"] ?? "1"), 10);
      if (successCount >= k) {
        return successOutcome({
          notes: `${successCount}/${results.length} branches succeeded (k=${k})`,
        });
      }
      if (waitingCount > 0 && successCount + waitingCount >= k) {
        return {
          status: StageStatus.WAITING,
          notes: `${successCount}/${results.length} branches succeeded, waiting for ${waitingCount} branches (k=${k})`,
        };
      }
      return failOutcome(
        `Only ${successCount}/${results.length} branches succeeded, need ${k}`,
      );
    }

    if (joinPolicy === "quorum") {
      const fraction = parseFloat(String(node.attrs["join_quorum"] ?? "0.5"));
      const required = Math.ceil(results.length * fraction);
      if (successCount >= required) {
        return successOutcome({
          notes: `${successCount}/${results.length} branches succeeded (quorum=${fraction}, required=${required})`,
        });
      }
      if (waitingCount > 0 && successCount + waitingCount >= required) {
        return {
          status: StageStatus.WAITING,
          notes: `${successCount}/${results.length} branches succeeded, waiting for ${waitingCount} branches (quorum=${fraction}, required=${required})`,
        };
      }
      return failOutcome(
        `Only ${successCount}/${results.length} branches succeeded, need ${required} (quorum=${fraction})`,
      );
    }

    // wait_all (default)
    if (failCount === 0 && waitingCount > 0) {
      return {
        status: StageStatus.WAITING,
        notes: `${waitingCount}/${results.length} branches are waiting for input`,
      };
    }
    if (failCount === 0) {
      return successOutcome({
        notes: `All ${results.length} branches succeeded`,
      });
    }
    return {
      status: StageStatus.PARTIAL_SUCCESS,
      notes: `${successCount}/${results.length} branches succeeded`,
    };
  }

  private readResumableResults(
    context: Context,
    expectedLength: number,
  ): Outcome[] | null {
    const raw = context.getString("parallel.results");
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Outcome[];
      if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
        return null;
      }
      if (!parsed.some((result) => result.status === StageStatus.WAITING)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Execute branches with bounded parallelism and error policy.
   *
   * - max_parallel controls how many branches execute concurrently (semaphore).
   * - error_policy="fail_fast" aborts remaining branches on first failure.
   * - error_policy="continue" (default) runs all branches regardless.
   * - error_policy="ignore" runs all branches; failures are still collected
   *   but will be excluded from join-policy counting.
   */
  private async executeBranches(
    branches: ReturnType<Graph["outgoingEdges"]>,
    context: Context,
    graph: Graph,
    logsRoot: string,
    maxParallel: number,
    errorPolicy: string,
  ): Promise<Outcome[]> {
    const branchIndexes = branches.map((_, index) => index);
    const resultsMap = await this.executeBranchIndexes(
      branchIndexes,
      branches,
      context,
      graph,
      logsRoot,
      maxParallel,
      errorPolicy,
    );
    return branchIndexes.map(
      (index) => resultsMap.get(index) ?? failOutcome("Branch execution did not produce an outcome"),
    );
  }

  private async executeBranchSubset(
    branchIndexes: number[],
    branches: ReturnType<Graph["outgoingEdges"]>,
    context: Context,
    graph: Graph,
    logsRoot: string,
    maxParallel: number,
    errorPolicy: string,
  ): Promise<Map<number, Outcome>> {
    return this.executeBranchIndexes(
      branchIndexes,
      branches,
      context,
      graph,
      logsRoot,
      maxParallel,
      errorPolicy,
    );
  }

  private async executeBranchIndexes(
    branchIndexes: number[],
    branches: ReturnType<Graph["outgoingEdges"]>,
    context: Context,
    graph: Graph,
    logsRoot: string,
    maxParallel: number,
    errorPolicy: string,
  ): Promise<Map<number, Outcome>> {
    const results = new Map<number, Outcome>();
    let cancelled = false;

    let active = 0;
    const waitQueue: Array<() => void> = [];

    const acquireSlot = async (): Promise<void> => {
      if (active < maxParallel) {
        active++;
        return;
      }
      await new Promise<void>((resolve) => {
        waitQueue.push(resolve);
      });
      active++;
    };

    const releaseSlot = (): void => {
      active--;
      if (waitQueue.length > 0) {
        const next = waitQueue.shift()!;
        next();
      }
    };

    const executeBranch = async (index: number): Promise<void> => {
      if (cancelled) {
        results.set(index, failOutcome("Cancelled due to fail_fast policy"));
        return;
      }

      await acquireSlot();

      if (cancelled) {
        releaseSlot();
        results.set(index, failOutcome("Cancelled due to fail_fast policy"));
        return;
      }

      try {
        const branchContext = context.clone();
        branchContext.set("internal.current_branch_key", branches[index]!.toNode);
        const outcome = await this.executeSubgraph!(
          branches[index]!.toNode,
          branchContext,
          graph,
          logsRoot,
        );
        results.set(index, outcome);

        if (errorPolicy === "fail_fast" && outcome.status === StageStatus.FAIL) {
          cancelled = true;
        }
      } catch (err) {
        results.set(index, failOutcome(String(err)));
        if (errorPolicy === "fail_fast") {
          cancelled = true;
        }
      } finally {
        releaseSlot();
      }
    };

    await Promise.all(branchIndexes.map((index) => executeBranch(index)));
    return results;
  }
}

/** Fan-in handler (spec §4.9): LLM evaluation when prompt is set, heuristic otherwise */
export class FanInHandler implements Handler {
  constructor(private backend: CodergenBackend | null = null) {}

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const resultsRaw = context.getString("parallel.results");
    if (!resultsRaw) {
      return failOutcome("No parallel results to evaluate");
    }

    let results: Outcome[];
    try {
      results = JSON.parse(resultsRaw) as Outcome[];
    } catch {
      return failOutcome("Failed to parse parallel results");
    }

    // LLM-based evaluation: when the fan-in node has a prompt, call the
    // backend to rank candidates instead of using the heuristic.
    if (node.prompt && this.backend) {
      try {
        const evalPrompt =
          node.prompt +
          "\n\n## Candidates\n" +
          results
            .map(
              (r, i) =>
                `### Candidate ${i + 1}\n- Status: ${r.status}\n- Notes: ${r.notes ?? "(none)"}`,
            )
            .join("\n\n");

        const backendResult = await this.backend.run(node, evalPrompt, context);
        if (typeof backendResult === "object" && "status" in backendResult) {
          return backendResult as Outcome;
        }

        // Backend returned a string — treat it as notes on the selection
        return successOutcome({
          contextUpdates: {
            "parallel.fan_in.best_outcome": StageStatus.SUCCESS,
            "parallel.fan_in.llm_evaluation": String(backendResult),
          },
          notes: `LLM evaluation: ${String(backendResult).slice(0, 200)}`,
        });
      } catch (err) {
        return failOutcome(`Fan-in LLM evaluation failed: ${String(err)}`);
      }
    }

    // Heuristic select: rank by status, pick best
    const statusRank: Record<string, number> = {
      [StageStatus.SUCCESS]: 0,
      [StageStatus.PARTIAL_SUCCESS]: 1,
      [StageStatus.WAITING]: 2,
      [StageStatus.RETRY]: 3,
      [StageStatus.FAIL]: 4,
      [StageStatus.SKIPPED]: 5,
    };

    results.sort((a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9));

    const best = results[0];
    if (!best) return failOutcome("No candidates available");

    return successOutcome({
      contextUpdates: {
        "parallel.fan_in.best_outcome": best.status,
      },
      notes: `Selected best candidate with status: ${best.status}`,
    });
  }
}

/** Tool handler: executes shell commands with optional pre/post hooks (spec §9.7) */
export class ToolHandler implements Handler {
  async execute(
    node: GraphNode,
    _context: Context,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const command = node.attrs["tool_command"] as string | undefined;
    if (!command) {
      return failOutcome("No tool_command specified");
    }

    const preHook = node.attrs["pre_hook"] as string | undefined;
    const postHook = node.attrs["post_hook"] as string | undefined;
    const timeout = node.timeout ?? 30000;

    try {
      const { execSync } = await import("node:child_process");
      const execOpts = {
        timeout,
        encoding: "utf-8" as const,
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      };

      const notes: string[] = [];

      // Run pre_hook if specified; failure aborts the tool
      if (preHook) {
        try {
          const preOut = execSync(preHook, execOpts);
          notes.push(`pre_hook output: ${preOut.trim()}`);
        } catch (preErr) {
          return failOutcome(`pre_hook failed: ${String(preErr)}`, {
            notes: `pre_hook command: ${preHook}`,
          });
        }
      }

      // Run the main tool_command
      const result = execSync(command, execOpts);
      notes.push(`Tool completed: ${command}`);

      // Run post_hook if specified; failure is noted but tool still succeeds
      if (postHook) {
        try {
          const postOut = execSync(postHook, execOpts);
          notes.push(`post_hook output: ${postOut.trim()}`);
        } catch (postErr) {
          notes.push(`post_hook failed: ${String(postErr)}`);
        }
      }

      return successOutcome({
        contextUpdates: { "tool.output": result },
        notes: notes.join("\n"),
      });
    } catch (err) {
      return failOutcome(String(err));
    }
  }
}

/** Manager loop handler — implements the full observe/steer cycle per spec §4.11 */
type ManagerAction = "observe" | "steer" | "wait";
type ManagerLockDecision = "resolved" | "reopen";

interface ManagerCycleSnapshot {
  cycle: number;
  childStatus: string;
  childOutcome: string;
  childLockDecision: string;
  steeringApplied: boolean;
  stopConditionMatched: boolean;
}

interface ManagerLoopArtifact {
  nodeId: string;
  startedAt: string;
  completedAt: string;
  actions: ManagerAction[];
  pollIntervalMs: number;
  maxCycles: number;
  stopCondition: string;
  cycleCount: number;
  finalStatus: StageStatus;
  finalChildStatus: string;
  finalChildOutcome: string;
  finalChildLockDecision: string;
  finalFailureReason: string;
  cycles: ManagerCycleSnapshot[];
}

function parseManagerActions(raw: unknown): ManagerAction[] {
  const allowed = new Set<ManagerAction>(["observe", "steer", "wait"]);
  const values = String(raw ?? "observe,wait")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is ManagerAction => allowed.has(value as ManagerAction));
  return values.length > 0 ? Array.from(new Set(values)) : ["observe", "wait"];
}

function parseManagerLockDecision(value: unknown): ManagerLockDecision | "" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "resolved" || normalized === "reopen") {
    return normalized;
  }
  return "";
}

function normalizeManagerTerminalStatus(
  childStatus: string,
  childOutcome: string,
): StageStatus | null {
  const normalizedStatus = childStatus.trim().toLowerCase();
  const normalizedOutcome = childOutcome.trim().toLowerCase();

  if (normalizedStatus === "failed") {
    return StageStatus.FAIL;
  }
  if (normalizedStatus !== "completed") {
    return null;
  }
  if (normalizedOutcome === "success" || normalizedOutcome === "") {
    return StageStatus.SUCCESS;
  }
  if (normalizedOutcome === "partial_success" || normalizedOutcome === "partial") {
    return StageStatus.PARTIAL_SUCCESS;
  }
  if (normalizedOutcome === "retry") {
    return StageStatus.RETRY;
  }
  if (normalizedOutcome === "skipped") {
    return StageStatus.SKIPPED;
  }
  if (normalizedOutcome === "fail" || normalizedOutcome === "failed" || normalizedOutcome === "error") {
    return StageStatus.FAIL;
  }
  return StageStatus.PARTIAL_SUCCESS;
}

function buildManagerConditionContext(
  context: Context,
  cycle: number,
  maxCycles: number,
  childStatus: string,
  childOutcome: string,
  childLockDecision: string,
): Context {
  const synthetic = context.clone();
  synthetic.applyUpdates({
    cycle,
    max_cycles: maxCycles,
    child_status: childStatus,
    child_outcome: childOutcome,
    child_lock_decision: childLockDecision,
    "stack.manager_loop.current_cycle": cycle,
    "stack.manager_loop.max_cycles": maxCycles,
    "stack.manager_loop.last_child_status": childStatus,
    "stack.manager_loop.last_child_outcome": childOutcome,
    "stack.manager_loop.last_child_lock": childLockDecision,
    "stack.manager_loop.lock_decision": childLockDecision,
  });
  return synthetic;
}

export class ManagerLoopHandler implements Handler {
  private observer?: ManagerObserver;
  private observerFactory?: ManagerObserverFactory;
  private childRuntimeFactory?: ManagerChildRuntimeFactory;
  private lastSteerTime = 0;

  constructor(private readonly steeringQueue: SteeringQueue = new InMemorySteeringQueue()) {}

  /** Wire an observer for the observe/steer cycle (analogous to ParallelHandler.setSubgraphExecutor) */
  setObserver(observer: ManagerObserver): void {
    this.observer = observer;
  }

  setObserverFactory(factory: ManagerObserverFactory): void {
    this.observerFactory = factory;
  }

  setChildRuntimeFactory(factory: ManagerChildRuntimeFactory): void {
    this.childRuntimeFactory = factory;
  }

  async execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const stageDir = path.join(logsRoot, node.id);
    fs.mkdirSync(stageDir, { recursive: true });
    const artifactPath = path.join(stageDir, "manager_loop.json");
    const startedAt = new Date().toISOString();
    const maxCycles = parseInt(String(node.attrs["manager.max_cycles"] ?? "1000"), 10);
    const pollIntervalStr = String(node.attrs["manager.poll_interval"] ?? "45s");
    let pollIntervalMs: number;
    try {
      pollIntervalMs = parseDuration(pollIntervalStr);
    } catch {
      pollIntervalMs = 45_000;
    }
    const stopCondition = String(node.attrs["manager.stop_condition"] ?? "");
    const actionsList = parseManagerActions(node.attrs["manager.actions"]);
    const actions = new Set(actionsList);
    const steerCooldownMs = parseInt(String(node.attrs["manager.steer_cooldown_ms"] ?? String(pollIntervalMs)), 10);

    const childRuntime = await this.childRuntimeFactory?.({
      node,
      context,
      graph,
      logsRoot,
      steeringQueue: this.steeringQueue,
    });
    const childExecution =
      (childRuntime
        ? await childRuntime.ensureChildExecution(context)
        : getManagerChildExecution(context) ?? inferAttachedManagerChildExecution(node, context)) ??
      null;

    if (childExecution) {
      applyManagerChildExecution(context, childExecution);
    }

    if (childExecution?.autostart) {
      await childRuntime?.startChildExecution(context);
    }

    const observer =
      this.observer ??
      (childExecution
        ? await this.observerFactory?.({
            node,
            context,
            graph,
            logsRoot,
            steeringQueue: this.steeringQueue,
            childExecution,
            ...(childRuntime ? { childRuntime } : {}),
          })
        : null);

    if (!observer) {
      return failOutcome("Manager loop observer wiring is missing");
    }

    // Reset steer timer for this execution
    this.lastSteerTime = 0;
    const cycles: ManagerCycleSnapshot[] = [];
    let lastChildStatus = "";
    let lastChildOutcome = "";
    let lastChildLockDecision = "";

    const finalize = (
      status: StageStatus,
      failureReason = "",
      notes = "",
      finalCycle = cycles.length,
    ): Outcome => {
      const artifact: ManagerLoopArtifact = {
        nodeId: node.id,
        startedAt,
        completedAt: new Date().toISOString(),
        actions: actionsList,
        pollIntervalMs,
        maxCycles,
        stopCondition,
        cycleCount: cycles.length,
        finalStatus: status,
        finalChildStatus: lastChildStatus,
        finalChildOutcome: lastChildOutcome,
        finalChildLockDecision: lastChildLockDecision,
        finalFailureReason: failureReason,
        cycles,
      };
      fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
      const contextUpdates: Record<string, unknown> = {
        "manager.final_cycle": finalCycle,
        "stack.manager_loop.artifact_path": artifactPath,
        "stack.manager_loop.cycle_count": cycles.length,
        "stack.manager_loop.last_child_status": lastChildStatus,
        "stack.manager_loop.last_child_outcome": lastChildOutcome,
        "stack.manager_loop.last_child_lock": lastChildLockDecision,
        "stack.manager_loop.lock_decision": lastChildLockDecision,
      };
      if (failureReason) {
        return failOutcome(failureReason, { notes, contextUpdates });
      }
      return { status, notes, contextUpdates };
    };

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      context.set("manager.current_cycle", cycle);
      context.set("stack.manager_loop.current_cycle", cycle);
      context.set("stack.manager_loop.max_cycles", maxCycles);

      // 1. Observe
      if (actions.has("observe")) {
        const observeResult = await observer.observe(context);

        // Write telemetry into context
        context.set("stack.child.status", observeResult.childStatus);
        if (observeResult.childOutcome !== undefined) {
          context.set("stack.child.outcome", observeResult.childOutcome);
        } else {
          context.delete("stack.child.outcome");
        }
        if (observeResult.childLockDecision !== undefined) {
          context.set("stack.child.lock_decision", observeResult.childLockDecision);
        } else {
          context.delete("stack.child.lock_decision");
        }
        if (observeResult.telemetry) {
          for (const [key, value] of Object.entries(observeResult.telemetry)) {
            context.set(`stack.child.telemetry.${key}`, value);
          }
        }
      }

      const childStatus = context.getString("stack.child.status");
      const childOutcome = context.getString("stack.child.outcome");
      const childLockDecision = parseManagerLockDecision(
        context.getString("stack.child.lock_decision"),
      );
      lastChildStatus = childStatus;
      lastChildOutcome = childOutcome;
      lastChildLockDecision = childLockDecision;

      const currentOutcome: Outcome = {
        status:
          normalizeManagerTerminalStatus(childStatus, childOutcome) ??
          StageStatus.SUCCESS,
      };
      const stopConditionMatched = stopCondition
        ? evaluateCondition(
            stopCondition,
            currentOutcome,
            buildManagerConditionContext(
              context,
              cycle,
              maxCycles,
              childStatus,
              childOutcome,
              childLockDecision,
            ),
          )
        : false;

      const terminalStatus = normalizeManagerTerminalStatus(childStatus, childOutcome);
      const childActive = terminalStatus === null;
      let steeringApplied = false;

      // 2. Steer (with cooldown)
      if (
        childActive &&
        actions.has("steer") &&
        this.steerCooldownElapsed(steerCooldownMs)
      ) {
        steeringApplied = this.enqueueSteering(context, node);
        if (steeringApplied) {
          this.lastSteerTime = Date.now();
        }
      }
      cycles.push({
        cycle,
        childStatus,
        childOutcome,
        childLockDecision,
        steeringApplied,
        stopConditionMatched,
      });

      context.set("stack.manager_loop.cycle_count", cycles.length);
      context.set("stack.manager_loop.last_child_status", lastChildStatus);
      context.set("stack.manager_loop.last_child_outcome", lastChildOutcome);
      context.set("stack.manager_loop.last_child_lock", lastChildLockDecision);
      context.set("stack.manager_loop.lock_decision", lastChildLockDecision);

      // 3. Evaluate stop condition
      if (stopConditionMatched) {
        return finalize(
          currentOutcome.status,
          childLockDecision === "reopen" ? "Child requested reopen" : "",
          `Stop condition satisfied at cycle ${cycle}`,
          cycle,
        );
      }

      // 4. Evaluate child status
      if (terminalStatus !== null) {
        if (childLockDecision === "reopen") {
          return finalize(
            StageStatus.FAIL,
            "Child requested reopen",
            `Child completed supervision cycle at cycle ${cycle}`,
            cycle,
          );
        }
        if (terminalStatus === StageStatus.FAIL) {
          return finalize(
            terminalStatus,
            `Child failed at cycle ${cycle}`,
            childOutcome ? `Child outcome: ${childOutcome}` : "",
            cycle,
          );
        }
        return finalize(
          terminalStatus,
          "",
          `Child completed supervision cycle at cycle ${cycle}`,
          cycle,
        );
      }

      // 5. Wait
      if (actions.has("wait") && cycle < maxCycles) {
        await sleep(pollIntervalMs);
      }
    }

    return finalize(
      StageStatus.FAIL,
      "Max cycles exceeded",
      `Manager loop exhausted ${maxCycles} cycles`,
      maxCycles,
    );
  }

  private steerCooldownElapsed(cooldownMs: number): boolean {
    if (this.lastSteerTime === 0) return true;
    return Date.now() - this.lastSteerTime >= cooldownMs;
  }

  private enqueueSteering(context: Context, node: GraphNode): boolean {
    const message =
      context.getString("manager.steering_message") ||
      context.getString("stack.manager.steering_message") ||
      String(node.attrs["manager.steering_message"] ?? "").trim();
    if (!message) {
      return false;
    }
    const target = getManagerChildSteeringTarget(context);
    if (!target) {
      return false;
    }

    this.steeringQueue.enqueue(
      createSteeringMessage({
        target,
        message,
        source: "manager",
      }),
    );
    return true;
  }
}

function inferAttachedManagerChildExecution(
  node: GraphNode,
  context: Context,
) {
  const runId = context.getString("internal.run_id");
  const executionId = context.getString("internal.last_completed_execution_id");
  if (!runId || !executionId) {
    return null;
  }
  const branchKey = context.getString("internal.last_completed_branch_key");
  const nodeId = context.getString("internal.last_completed_node_id");
  return createManagerChildExecution({
    id: `${runId}:${node.id}:attached-child`,
    runId,
    ownerNodeId: node.id,
    source: "attached",
    autostart: false,
    adapterTarget: {
      executionId,
      ...(branchKey ? { branchKey } : {}),
      ...(nodeId ? { nodeId } : {}),
    },
  });
}

// ── Helpers ──

function writeStatus(stageDir: string, outcome: Outcome): void {
  const data = {
    outcome: outcome.status,
    preferred_next_label: outcome.preferredLabel ?? "",
    suggested_next_ids: outcome.suggestedNextIds ?? [],
    context_updates: outcome.contextUpdates ?? {},
    notes: outcome.notes ?? "",
  };
  fs.writeFileSync(
    path.join(stageDir, "status.json"),
    JSON.stringify(data, null, 2),
  );
}

/**
 * Synthesize a preamble from a fidelity-filtered context snapshot (spec §9.2).
 * Converts key-value pairs into a readable text block that gives the LLM
 * enough context to continue work without full conversation history.
 */
function synthesizePreamble(snapshot: Record<string, unknown>): string {
  const entries = Object.entries(snapshot).filter(
    ([key]) => !key.startsWith("internal."),
  );
  if (entries.length === 0) return "";

  const lines = entries.map(([key, value]) => {
    const v = value === "" ? "(empty)" : String(value);
    return `- ${key}: ${v}`;
  });
  return "## Context from previous stages\n" + lines.join("\n");
}

/**
 * Parse accelerator key from edge label.
 * Patterns: [K] Label, K) Label, K - Label, or first character.
 */
function parseAcceleratorKey(label: string): string {
  // [K] Label
  const bracketMatch = label.match(/^\[([A-Za-z0-9])\]\s*/);
  if (bracketMatch) return bracketMatch[1]!;

  // K) Label
  const parenMatch = label.match(/^([A-Za-z0-9])\)\s*/);
  if (parenMatch) return parenMatch[1]!;

  // K - Label
  const dashMatch = label.match(/^([A-Za-z0-9])\s*-\s*/);
  if (dashMatch) return dashMatch[1]!;

  // First character
  return label.charAt(0).toUpperCase();
}
