import * as fs from "node:fs";
import * as path from "node:path";
import type { Graph, GraphEdge, GraphNode } from "../model/graph.js";
import type {
  AttachedExecutionSupervisor,
  CapableBackend,
} from "../backend/contracts.js";
import { Context } from "../state/context.js";
import { Checkpoint } from "../state/checkpoint.js";
import type { Outcome } from "../state/types.js";
import { StageStatus, failOutcome } from "../state/types.js";
import { applyOutcomeRuntimeContext } from "../state/outcome-runtime.js";
import { resolveEffectiveFidelity, resolveThreadKey } from "../state/fidelity.js";
import { EventEmitter, type PipelineEvent } from "../events/index.js";
import { HandlerRegistry } from "../handlers/registry.js";
import type {
  CodergenBackend,
  Interviewer,
  ManagerChildRuntime,
  ManagerChildRuntimeFactoryInput,
  ManagerObserver,
  ManagerObserverFactory,
} from "../handlers/types.js";
import { InMemorySteeringQueue, type SteeringQueue } from "../steering/queue.js";
import {
  applyManagerChildExecution,
  createManagerChildExecution,
  type ManagerChildExecution,
} from "../manager/child-execution.js";
import { evaluateCondition } from "../conditions/index.js";
import { selectEdge } from "./edge-selection.js";
import { buildRetryPolicy, delayForAttempt, sleep } from "./retry.js";
import { preparePipeline } from "./pipeline.js";

function mirrorNodeScopedContext(
  context: Context,
  nodeId: string,
  outcome: Outcome,
): void {
  for (const [key, value] of Object.entries(outcome.contextUpdates ?? {})) {
    if (key.startsWith("internal.")) continue;
    context.set(`node.${nodeId}.${key}`, value);
  }

  context.set(`node.${nodeId}.outcome`, outcome.status);
  if (outcome.failureReason) {
    context.set(`node.${nodeId}.failure.reason`, outcome.failureReason);
  }
  if (outcome.preferredLabel) {
    context.set(`node.${nodeId}.preferred_label`, outcome.preferredLabel);
  }
}

export interface RunConfig {
  backend?: CodergenBackend | null;
  interviewer?: Interviewer;
  managerObserverFactory?: ManagerObserverFactory;
  steeringQueue?: SteeringQueue;
  runId?: string;
  logsRoot?: string;
  resumeFrom?: string;
  onEvent?: (event: PipelineEvent) => void;
  onManagerChildExecution?: (execution: ManagerChildExecution) => void;
}

export interface RunResult {
  outcome: Outcome;
  completedNodes: string[];
  context: Context;
}

/** The core pipeline execution engine */
export class PipelineRunner {
  private registry: HandlerRegistry;
  private emitter = new EventEmitter();

  constructor(private config: RunConfig = {}) {
    this.registry = new HandlerRegistry({
      backend: config.backend ?? null,
      interviewer: config.interviewer,
      steeringQueue: config.steeringQueue ?? new InMemorySteeringQueue(),
    });

    if (config.onEvent) {
      this.emitter.on(config.onEvent);
    }

    // Wire the subgraph executor into the ParallelHandler
    this.wireParallelHandler();
    this.wireManagerLoopHandler();
  }

  /** Wire the subgraph executor callback into the ParallelHandler */
  private wireParallelHandler(): void {
    const parallelHandler = this.registry.getParallelHandler();
    if (parallelHandler) {
      parallelHandler.setSubgraphExecutor(
        (startNodeId, context, graph, logsRoot) =>
          this.executeSubgraph(startNodeId, context, graph, logsRoot),
      );
    }
  }

  private wireManagerLoopHandler(): void {
    const managerLoopHandler = this.registry.getManagerLoopHandler();
    if (managerLoopHandler) {
      managerLoopHandler.setChildRuntimeFactory(
        (input) => new PipelineManagerChildRuntime(input, this.config),
      );
      managerLoopHandler.setObserverFactory(async (input) => {
        if (
          input.childExecution.kind === "managed_pipeline" &&
          input.childRuntime instanceof PipelineManagerChildRuntime
        ) {
          return new PipelineManagerChildRuntimeObserver(input.childRuntime);
        }
        if (input.childExecution.kind === "attached_backend_execution") {
          const supervisor = getAttachedExecutionSupervisor(this.config.backend);
          if (supervisor) {
            return new AttachedExecutionManagerObserver(
              supervisor,
              input.childExecution.attachedTarget,
            );
          }
        }
        return this.config.managerObserverFactory?.(input) ?? null;
      });
    }
  }

  /**
   * Execute a subgraph starting from a given node, walking through the graph
   * until a terminal node or dead-end is reached. Used by ParallelHandler
   * to run each branch concurrently with an isolated context.
   */
  private async executeSubgraph(
    startNodeId: string,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    let currentNode = graph.getNode(startNodeId);
    let lastOutcome: Outcome = { status: StageStatus.SUCCESS };
    let subgraphIncomingEdge: GraphEdge | null = null;
    let subgraphPreviousNodeId = "";

    while (true) {
      // Check for terminal node or fan-in convergence point
      if (graph.isTerminal(currentNode) || this.isSubgraphBoundary(currentNode, graph)) {
        break;
      }

      // Set incoming edge fidelity context for handlers
      context.set("internal.incoming_edge_fidelity", subgraphIncomingEdge?.fidelity ?? "");
      context.set("internal.incoming_edge_thread_id", subgraphIncomingEdge?.threadId ?? "");
      const effectiveFidelity = resolveEffectiveFidelity(
        subgraphIncomingEdge?.fidelity ?? "",
        currentNode.fidelity,
        graph.attrs.defaultFidelity,
      );
      context.set("internal.effective_fidelity", effectiveFidelity);

      const threadKey = resolveThreadKey({
        nodeThreadId: currentNode.threadId,
        edgeThreadId: subgraphIncomingEdge?.threadId ?? "",
        graphDefaultThread: String(graph.attrs["default_thread"] ?? ""),
        subgraphClass: currentNode.classes.length > 0 ? currentNode.classes[0]! : "",
        previousNodeId: subgraphPreviousNodeId,
      });
      if (effectiveFidelity === "full") {
        context.set("internal.thread_key", threadKey);
      } else {
        context.delete("internal.thread_key");
      }
      context.delete("internal.current_backend_execution_ref");
      context.set("internal.current_node_id", currentNode.id);

      // Execute the handler for this node
      const handler = this.registry.resolve(currentNode);
      try {
        lastOutcome = await handler.execute(currentNode, context, graph, logsRoot);
      } catch (err) {
        return failOutcome(String(err));
      }

      // Apply context updates
      if (lastOutcome.contextUpdates) {
        context.applyUpdates(lastOutcome.contextUpdates as Record<string, unknown>);
      }
      applyOutcomeRuntimeContext(context, lastOutcome);
      if (lastOutcome.status !== StageStatus.WAITING) {
        mirrorNodeScopedContext(context, currentNode.id, lastOutcome);
      }
      const completedThreadKey = context.getString("internal.thread_key");
      if (completedThreadKey) {
        context.set("internal.last_completed_thread_key", completedThreadKey);
      } else {
        context.delete("internal.last_completed_thread_key");
      }
      context.set("internal.last_completed_node_id", currentNode.id);
      const currentBranchKey = context.getString("internal.current_branch_key");
      if (currentBranchKey) {
        context.set("internal.last_completed_branch_key", currentBranchKey);
      } else {
        context.delete("internal.last_completed_branch_key");
      }

      // If the handler failed, stop the subgraph execution
      if (
        lastOutcome.status === StageStatus.FAIL ||
        lastOutcome.status === StageStatus.WAITING
      ) {
        return lastOutcome;
      }

      // Select the next edge
      const outgoing = graph.outgoingEdges(currentNode.id);
      const nextEdge = selectEdge(outgoing, lastOutcome, context);

      if (!nextEdge) {
        // No more edges: subgraph walk is done
        break;
      }

      subgraphPreviousNodeId = currentNode.id;
      subgraphIncomingEdge = nextEdge;
      currentNode = graph.getNode(nextEdge.toNode);
    }

    return lastOutcome;
  }

  /**
   * Check if a node is a subgraph boundary where branch execution should stop.
   * Fan-in nodes (parallel.fan_in) are convergence points that should be
   * executed by the main pipeline loop, not within individual branches.
   */
  private isSubgraphBoundary(node: GraphNode, graph: Graph): boolean {
    const handlerType = graph.resolveHandlerType(node);
    return handlerType === "parallel.fan_in";
  }

  /** Register a custom handler */
  registerHandler(typeString: string, handler: import("../handlers/types.js").Handler): void {
    this.registry.register(typeString, handler);
  }

  /** Run a pipeline graph */
  async run(graph: Graph, overrideContext?: Context): Promise<RunResult> {
    const logsRoot = this.config.logsRoot ?? path.join(process.cwd(), ".attractor-runs", Date.now().toString());
    fs.mkdirSync(logsRoot, { recursive: true });

    // Write manifest
    const manifest = {
      name: graph.id,
      goal: graph.attrs.goal,
      startTime: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(logsRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

    const context = overrideContext ?? new Context();
    const runId = this.config.runId ?? path.basename(logsRoot);
    const completedNodes: string[] = [];
    const nodeOutcomes = new Map<string, Outcome>();

    // Mirror graph attributes into context
    context.set("graph.goal", graph.attrs.goal);
    context.set("internal.run_id", runId);

    const startTime = Date.now();
    this.emitter.emit({
      type: "pipeline_started",
      name: graph.id,
      id: logsRoot,
      timestamp: new Date().toISOString(),
    });

    // Find start node
    const startNode = graph.findStartNode();
    if (!startNode) {
      const err = failOutcome("No start node found");
      this.emitter.emit({
        type: "pipeline_failed",
        error: "No start node found",
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
      return { outcome: err, completedNodes, context };
    }

    let currentNode: GraphNode = startNode;
    let lastOutcome: Outcome = { status: StageStatus.SUCCESS };
    let stageIndex = 0;
    let incomingEdge: GraphEdge | null = null;
    let previousNodeId = "";
    // Flag for resume fidelity degradation (spec §5.3 point 6):
    // When resuming, if the last completed node used full fidelity,
    // degrade the first resumed node to summary:high.
    let degradeNextFidelity = false;

    // Checkpoint resume: restore state from a previous run
    if (this.config.resumeFrom) {
      const resumeDir = this.config.resumeFrom;
      if (Checkpoint.exists(resumeDir)) {
        const cp = Checkpoint.load(resumeDir);

        // Restore context values from the checkpoint
        context.applyUpdates(cp.contextValues);

        // Restore completed node ordering
        for (const nodeId of cp.completedNodes) {
          completedNodes.push(nodeId);
        }
        // Restore real node outcomes from checkpoint
        for (const [nodeId, outcome] of Object.entries(cp.nodeOutcomes)) {
          nodeOutcomes.set(nodeId, outcome);
        }

        // Restore retry counters into context
        for (const [nodeId, count] of Object.entries(cp.nodeRetries)) {
          context.set(`internal.retry_count.${nodeId}`, count);
        }

        // Determine the resume point: find the next node after the last completed node.
        // The checkpoint's currentNode is the last node that was completed.
        // We need to find the outgoing edge from it and advance there.
        const lastCompletedId = cp.currentNode;
        if (lastCompletedId && graph.nodes.has(lastCompletedId)) {
          const lastNode = graph.getNode(lastCompletedId);

          if (graph.isTerminal(lastNode)) {
            // The last completed node was a terminal; pipeline was already done
            // Just return success
            return { outcome: lastOutcome, completedNodes, context };
          }

          const lastCompletedOutcome = nodeOutcomes.get(lastCompletedId);
          if (!lastCompletedOutcome) {
            throw new Error(
              `Checkpoint is missing node outcome for completed node '${lastCompletedId}'`,
            );
          }

          const nextStep = this.resolveNextStep(lastNode, lastCompletedOutcome, graph, context);

          if (nextStep) {
            currentNode = graph.getNode(nextStep.toNode);
            incomingEdge = nextStep.edge;
            previousNodeId = lastCompletedId;
            lastOutcome = lastCompletedOutcome;

            // Resume degradation (spec §5.3 point 6): if the last completed node
            // used full fidelity, degrade the first resumed node to summary:high
            const lastNodeFidelity = resolveEffectiveFidelity(
              "",
              lastNode.fidelity,
              graph.attrs.defaultFidelity,
            );
            if (lastNodeFidelity === "full") {
              degradeNextFidelity = true;
            }
          } else {
            if (
              lastCompletedOutcome.status === StageStatus.FAIL ||
              lastCompletedOutcome.status === StageStatus.PARTIAL_SUCCESS
            ) {
              return { outcome: lastCompletedOutcome, completedNodes, context };
            }
            // No outgoing edge from last completed; re-execute from last completed
            currentNode = lastNode;
            // Remove from completed so it gets re-executed
            const idx = completedNodes.lastIndexOf(lastCompletedId);
            if (idx >= 0) completedNodes.splice(idx, 1);
            nodeOutcomes.delete(lastCompletedId);
          }
        }

        stageIndex = completedNodes.length;

        this.emitter.emit({
          type: "checkpoint_resumed",
          resumedFromNode: cp.currentNode,
          skippedNodes: [...cp.completedNodes],
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Core execution loop
    while (true) {
      const node = currentNode;
      context.set("current_node", node.id);

      // Step 1: Check for terminal node
      if (graph.isTerminal(node)) {
        const [gateOk, failedGate] = this.checkGoalGates(graph, nodeOutcomes);
        if (!gateOk && failedGate) {
          const retryTarget = this.getRetryTarget(failedGate, graph);
          if (retryTarget) {
            currentNode = graph.getNode(retryTarget);
            continue;
          }
          lastOutcome = failOutcome("Goal gate unsatisfied and no retry target");
          break;
        }
        // Record terminal node and save final checkpoint
        completedNodes.push(node.id);
        const termSnap = context.snapshot();
        const termRetries: Record<string, number> = {};
        for (const [key, value] of Object.entries(termSnap)) {
          if (key.startsWith("internal.retry_count.")) {
            termRetries[key.slice("internal.retry_count.".length)] = Number(value);
          }
        }
        new Checkpoint({
          currentNode: node.id,
          completedNodes: [...completedNodes],
          nodeOutcomes: Object.fromEntries(nodeOutcomes),
          nodeRetries: termRetries,
          context: termSnap,
          logs: [...context.getLogs()],
          waitingForQuestionId:
            context.getString("internal.waiting_for_question_id") || undefined,
        }).save(logsRoot);
        break;
      }

      // Step 1b: Set incoming edge fidelity and thread context for handlers.
      // This allows the CodergenHandler to read edge fidelity from context
      // for the §5.4 precedence chain.
      context.set("internal.incoming_edge_fidelity", incomingEdge?.fidelity ?? "");
      context.set("internal.incoming_edge_thread_id", incomingEdge?.threadId ?? "");

      // Resolve effective fidelity for this node (may be overridden by resume degradation)
      let effectiveFidelity = resolveEffectiveFidelity(
        incomingEdge?.fidelity ?? "",
        node.fidelity,
        graph.attrs.defaultFidelity,
      );

      // Resume degradation (spec §5.3 point 6): force summary:high on the first
      // node after resuming from a full-fidelity node
      if (degradeNextFidelity) {
        effectiveFidelity = "summary:high";
        context.set("internal.incoming_edge_fidelity", "summary:high");
        degradeNextFidelity = false;
      }

      // Thread resolution (spec §5.4): when fidelity is "full", determine thread key
      // for LLM session reuse.
      const threadKey = resolveThreadKey({
        nodeThreadId: node.threadId,
        edgeThreadId: incomingEdge?.threadId ?? "",
        graphDefaultThread: String(graph.attrs["default_thread"] ?? ""),
        subgraphClass: node.classes.length > 0 ? node.classes[0]! : "",
        previousNodeId,
      });
      if (effectiveFidelity === "full") {
        context.set("internal.thread_key", threadKey);
      } else {
        context.delete("internal.thread_key");
      }

      context.set("internal.effective_fidelity", effectiveFidelity);
      context.delete("internal.current_backend_execution_ref");
      context.set("internal.current_node_id", node.id);

      // Step 2: Execute node handler with retry
      const stageStart = Date.now();
      this.emitter.emit({
        type: "stage_started",
        name: node.id,
        index: stageIndex,
        timestamp: new Date().toISOString(),
      });

      const retryPolicy = buildRetryPolicy(node, graph);
      const outcome = await this.executeWithRetry(
        node,
        context,
        graph,
        logsRoot,
        retryPolicy,
        stageIndex,
      );

      // Step 3: Apply context updates
      if (outcome.contextUpdates) {
        context.applyUpdates(outcome.contextUpdates as Record<string, unknown>);
      }
      applyOutcomeRuntimeContext(context, outcome);

      // Waiting for human input: persist and stop execution without
      // marking the current node as completed.
      if (outcome.status === StageStatus.WAITING) {
        lastOutcome = outcome;
        const nodeRetries: Record<string, number> = {};
        const snap = context.snapshot();
        for (const [key, value] of Object.entries(snap)) {
          if (key.startsWith("internal.retry_count.")) {
            const nodeId = key.slice("internal.retry_count.".length);
            nodeRetries[nodeId] = Number(value);
          }
        }
        const lastCompletedNodeId =
          completedNodes.length > 0 ? completedNodes[completedNodes.length - 1]! : "";
        const checkpoint = new Checkpoint({
          currentNode: lastCompletedNodeId,
          completedNodes: [...completedNodes],
          nodeOutcomes: Object.fromEntries(nodeOutcomes),
          nodeRetries,
          context: snap,
          logs: [...context.getLogs()],
          waitingForQuestionId:
            context.getString("internal.waiting_for_question_id") || undefined,
        });
        checkpoint.save(logsRoot);
        this.emitter.emit({
          type: "checkpoint_saved",
          nodeId: node.id,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      mirrorNodeScopedContext(context, node.id, outcome);

      const stageDuration = Date.now() - stageStart;
      this.emitter.emit({
        type: "stage_completed",
        name: node.id,
        index: stageIndex,
        durationMs: stageDuration,
        timestamp: new Date().toISOString(),
      });

      // Step 4: Record completion
      completedNodes.push(node.id);
      nodeOutcomes.set(node.id, outcome);
      const completedThreadKey = context.getString("internal.thread_key");
      if (completedThreadKey) {
        context.set("internal.last_completed_thread_key", completedThreadKey);
      } else {
        context.delete("internal.last_completed_thread_key");
      }
      context.set("internal.last_completed_node_id", node.id);
      const currentBranchKey = context.getString("internal.current_branch_key");
      if (currentBranchKey) {
        context.set("internal.last_completed_branch_key", currentBranchKey);
      } else {
        context.delete("internal.last_completed_branch_key");
      }
      lastOutcome = outcome;
      stageIndex++;

      // Step 5: Save checkpoint
      const nodeRetries: Record<string, number> = {};
      const snap = context.snapshot();
      for (const [key, value] of Object.entries(snap)) {
        if (key.startsWith("internal.retry_count.")) {
          const nodeId = key.slice("internal.retry_count.".length);
          nodeRetries[nodeId] = Number(value);
        }
      }
      const checkpoint = new Checkpoint({
        currentNode: node.id,
        completedNodes: [...completedNodes],
        nodeOutcomes: Object.fromEntries(nodeOutcomes),
        nodeRetries,
        context: snap,
        logs: [...context.getLogs()],
        waitingForQuestionId:
          context.getString("internal.waiting_for_question_id") || undefined,
      });
      checkpoint.save(logsRoot);
      this.emitter.emit({
        type: "checkpoint_saved",
        nodeId: node.id,
        timestamp: new Date().toISOString(),
      });

      // Step 6: Select next edge
      const nextStep = this.resolveNextStep(node, outcome, graph, context);

      if (!nextStep) {
        if (outcome.status === StageStatus.FAIL) {
          lastOutcome = outcome;
        }
        break;
      }

      // Step 7: Handle loop_restart — reset retry counters so the
      //         target node (and downstream nodes) execute as a fresh loop iteration.
      if (nextStep.edge?.loopRestart) {
        // Clear all internal retry counters stored in context
        const snapshot = context.snapshot();
        for (const key of Object.keys(snapshot)) {
          if (key.startsWith("internal.retry_count.")) {
            context.delete(key);
          }
        }

        // Remove the target node (and any nodes it can reach) from
        // nodeOutcomes so goal-gate checks see them as unvisited.
        const reachable = graph.reachableFrom(nextStep.toNode);
        for (const nodeId of reachable) {
          nodeOutcomes.delete(nodeId);
        }

        this.emitter.emit({
          type: "loop_restarted",
          fromNode: node.id,
          toNode: nextStep.toNode,
          timestamp: new Date().toISOString(),
        });
      }

      // Step 8: Advance to next node, tracking incoming edge for fidelity/thread resolution
      previousNodeId = node.id;
      incomingEdge = nextStep.edge;
      currentNode = graph.getNode(nextStep.toNode);
    }

    const totalDuration = Date.now() - startTime;
    if (lastOutcome.status === StageStatus.SUCCESS || lastOutcome.status === StageStatus.PARTIAL_SUCCESS) {
      this.emitter.emit({
        type: "pipeline_completed",
        durationMs: totalDuration,
        artifactCount: completedNodes.length,
        timestamp: new Date().toISOString(),
      });
    } else if (lastOutcome.status === StageStatus.FAIL) {
      this.emitter.emit({
        type: "pipeline_failed",
        error: lastOutcome.failureReason ?? "Pipeline failed",
        durationMs: totalDuration,
        timestamp: new Date().toISOString(),
      });
    }

    return { outcome: lastOutcome, completedNodes, context };
  }

  private async executeWithRetry(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
    retryPolicy: RetryPolicy,
    stageIndex: number,
  ): Promise<Outcome> {
    const handler = this.registry.resolve(node);

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      try {
        const outcome = await handler.execute(node, context, graph, logsRoot);

        if (
          outcome.status === StageStatus.SUCCESS ||
          outcome.status === StageStatus.PARTIAL_SUCCESS
        ) {
          return outcome;
        }

        if (outcome.status === StageStatus.WAITING) {
          return outcome;
        }

        if (outcome.status === StageStatus.RETRY) {
          if (attempt < retryPolicy.maxAttempts) {
            const retryKey = `internal.retry_count.${node.id}`;
            context.set(retryKey, context.getNumber(retryKey) + 1);

            const delay = delayForAttempt(attempt, retryPolicy.backoff);
            this.emitter.emit({
              type: "stage_retrying",
              name: node.id,
              index: stageIndex,
              attempt,
              delayMs: delay,
              timestamp: new Date().toISOString(),
            });
            await sleep(delay);
            continue;
          }
          if (node.allowPartial) {
            return {
              status: StageStatus.PARTIAL_SUCCESS,
              notes: "retries exhausted, partial accepted",
            };
          }
          return failOutcome("max retries exceeded");
        }

        if (outcome.status === StageStatus.FAIL) {
          return outcome;
        }

        return outcome;
      } catch (err) {
        if (retryPolicy.shouldRetry(err as Error) && attempt < retryPolicy.maxAttempts) {
          const delay = delayForAttempt(attempt, retryPolicy.backoff);
          this.emitter.emit({
            type: "stage_retrying",
            name: node.id,
            index: stageIndex,
            attempt,
            delayMs: delay,
            timestamp: new Date().toISOString(),
          });
          await sleep(delay);
          continue;
        }
        return failOutcome(String(err));
      }
    }

    return failOutcome("max retries exceeded");
  }

  private checkGoalGates(
    graph: Graph,
    nodeOutcomes: Map<string, Outcome>,
  ): [boolean, GraphNode | null] {
    for (const node of graph.nodes.values()) {
      if (!node.goalGate) {
        continue;
      }

      const outcome = nodeOutcomes.get(node.id);
      if (
        !outcome ||
        (outcome.status !== StageStatus.SUCCESS &&
          outcome.status !== StageStatus.PARTIAL_SUCCESS)
      ) {
        return [false, node];
      }
    }
    return [true, null];
  }

  private getRetryTarget(node: GraphNode, graph: Graph): string | null {
    if (node.retryTarget && graph.nodes.has(node.retryTarget)) {
      return node.retryTarget;
    }
    if (node.fallbackRetryTarget && graph.nodes.has(node.fallbackRetryTarget)) {
      return node.fallbackRetryTarget;
    }
    if (graph.attrs.retryTarget && graph.nodes.has(graph.attrs.retryTarget)) {
      return graph.attrs.retryTarget;
    }
    if (graph.attrs.fallbackRetryTarget && graph.nodes.has(graph.attrs.fallbackRetryTarget)) {
      return graph.attrs.fallbackRetryTarget;
    }
    return null;
  }

  private resolveNextStep(
    node: GraphNode,
    outcome: Outcome,
    graph: Graph,
    context: Context,
  ): { toNode: string; edge: GraphEdge | null } | null {
    const outgoing = graph.outgoingEdges(node.id);
    if (outcome.status === StageStatus.FAIL) {
      const failEdge = this.selectMatchingConditionalEdge(outgoing, outcome, context);
      if (failEdge) {
        return { toNode: failEdge.toNode, edge: failEdge };
      }

      const retryTarget = this.getRetryTarget(node, graph);
      if (!retryTarget) {
        return null;
      }

      return { toNode: retryTarget, edge: null };
    }

    const nextEdge = selectEdge(outgoing, outcome, context);
    if (!nextEdge) {
      return null;
    }

    return { toNode: nextEdge.toNode, edge: nextEdge };
  }

  private selectMatchingConditionalEdge(
    edges: GraphEdge[],
    outcome: Outcome,
    context: Context,
  ): GraphEdge | null {
    const conditionMatched = edges.filter(
      (edge) => edge.condition && evaluateCondition(edge.condition, outcome, context),
    );
    if (conditionMatched.length === 0) {
      return null;
    }

    const sorted = [...conditionMatched].sort((a, b) => {
      if (b.weight !== a.weight) {
        return b.weight - a.weight;
      }
      return a.toNode.localeCompare(b.toNode);
    });
    return sorted[0] ?? null;
  }

  /** Get the event emitter for subscribing to events */
  get events(): EventEmitter {
    return this.emitter;
  }
}

class PipelineManagerChildRuntime implements ManagerChildRuntime {
  private childExecution: ManagerChildExecution | null = null;
  private childStarted = false;
  private childCurrentNode: string | null = null;
  private readonly childCompletedNodes: string[] = [];
  private childResult: RunResult | null = null;
  private childError: string | null = null;

  constructor(
    private readonly input: ManagerChildRuntimeFactoryInput,
    private readonly runConfig: RunConfig,
  ) {}

  async ensureChildExecution(_context: Context): Promise<ManagerChildExecution> {
    if (this.childExecution) {
      return this.childExecution;
    }

    const parentRunId =
      this.input.context.getString("internal.run_id") ||
      this.runConfig.runId ||
      path.basename(this.input.logsRoot);
    const childDotfile = String(this.input.graph.attrs["stack.child_dotfile"] ?? "").trim();
    const autostart =
      String(this.input.graph.attrs["stack.child_autostart"] ?? "true").toLowerCase() !== "false";
    const backendExecutionRef = this.input.context.getString(
      "internal.last_completed_backend_execution_ref",
    );
    const attachedBranchKey = this.input.context.getString("internal.last_completed_branch_key");
    const attachedNodeId = this.input.context.getString("internal.last_completed_node_id");

    if (childDotfile) {
      const resolvedDotfile = path.isAbsolute(childDotfile)
        ? childDotfile
        : path.resolve(process.cwd(), childDotfile);
      const execution = createManagerChildExecution({
        id: `${parentRunId}:${this.input.node.id}:child`,
        runId: `${parentRunId}:${this.input.node.id}:child-run`,
        ownerNodeId: this.input.node.id,
        kind: "managed_pipeline",
        autostart,
        dotfile: resolvedDotfile,
      });
      this.childExecution = execution;
      this.runConfig.onManagerChildExecution?.(execution);
      return execution;
    }

    if (!backendExecutionRef) {
      throw new Error("Manager loop child execution is missing");
    }

    const execution = createManagerChildExecution({
      id: `${parentRunId}:${this.input.node.id}:attached-child`,
      runId: parentRunId,
      ownerNodeId: this.input.node.id,
      kind: "attached_backend_execution",
      autostart: false,
      attachedTarget: {
        backendExecutionRef,
        ...(attachedBranchKey ? { branchKey: attachedBranchKey } : {}),
        ...(attachedNodeId ? { nodeId: attachedNodeId } : {}),
      },
    });
    this.childExecution = execution;
    this.runConfig.onManagerChildExecution?.(execution);
    return execution;
  }

  async startChildExecution(context: Context): Promise<void> {
    const execution = await this.ensureChildExecution(context);
    if (execution.kind !== "managed_pipeline" || this.childStarted) {
      return;
    }
    if (!fs.existsSync(execution.dotfile)) {
      throw new Error(`Manager child DOT file not found: ${execution.dotfile}`);
    }

    this.childStarted = true;
    const dotSource = fs.readFileSync(execution.dotfile, "utf-8");
    const { graph } = preparePipeline(dotSource, { dotFilePath: execution.dotfile });
    const childLogsRoot = path.join(this.input.logsRoot, ".manager-child", execution.id);
    fs.mkdirSync(childLogsRoot, { recursive: true });

    const childContext = context.clone();
    applyManagerChildExecution(childContext, execution);

    const childRunner = new PipelineRunner({
      backend: this.runConfig.backend,
      interviewer: this.runConfig.interviewer,
      managerObserverFactory: this.runConfig.managerObserverFactory,
      steeringQueue: this.runConfig.steeringQueue,
      runId: execution.runId,
      logsRoot: childLogsRoot,
      onManagerChildExecution: this.runConfig.onManagerChildExecution,
      onEvent: (event) => {
        if (event.type === "stage_started") {
          this.childCurrentNode = event.name;
        }
        if (
          event.type === "stage_completed" &&
          !this.childCompletedNodes.includes(event.name)
        ) {
          this.childCompletedNodes.push(event.name);
          this.childCurrentNode = event.name;
        }
      },
    });

    void childRunner
      .run(graph, childContext)
      .then((result) => {
        this.childResult = result;
        this.childCurrentNode =
          result.completedNodes[result.completedNodes.length - 1] ?? this.childCurrentNode;
        for (const nodeId of result.completedNodes) {
          if (!this.childCompletedNodes.includes(nodeId)) {
            this.childCompletedNodes.push(nodeId);
          }
        }
      })
      .catch((err: unknown) => {
        this.childError = String(err);
      });
  }

  getSnapshot(): {
    childStatus: "running" | "completed" | "failed";
    childOutcome?: string;
    telemetry: Record<string, unknown>;
  } {
    if (this.childError) {
      return {
        childStatus: "failed",
        childOutcome: "error",
        telemetry: {
          current_node: this.childCurrentNode ?? "",
          completed_nodes: [...this.childCompletedNodes],
          failure_reason: this.childError,
        },
      };
    }

    if (this.childResult) {
      const childOutcome = mapManagerChildOutcome(this.childResult.outcome.status);
      return {
        childStatus: this.childResult.outcome.status === StageStatus.FAIL ? "failed" : "completed",
        ...(childOutcome ? { childOutcome } : {}),
        telemetry: {
          current_node: this.childCurrentNode ?? "",
          completed_nodes: [...this.childCompletedNodes],
        },
      };
    }

    return {
      childStatus: "running",
      telemetry: {
        current_node: this.childCurrentNode ?? "",
        completed_nodes: [...this.childCompletedNodes],
        autostarted: this.childStarted,
      },
    };
  }
}

class PipelineManagerChildRuntimeObserver implements ManagerObserver {
  constructor(private readonly childRuntime: PipelineManagerChildRuntime) {}

  async observe(): Promise<{
    childStatus: "running" | "completed" | "failed";
    childOutcome?: string;
    telemetry?: Record<string, unknown>;
  }> {
    return this.childRuntime.getSnapshot();
  }
}

class AttachedExecutionManagerObserver implements ManagerObserver {
  constructor(
    private readonly supervisor: AttachedExecutionSupervisor,
    private readonly target: import("../backend/contracts.js").AttachedExecutionTarget,
  ) {}

  async observe(context: Context): Promise<{
    childStatus: "running" | "completed" | "failed";
    childOutcome?: string;
    childLockDecision?: "resolved" | "reopen";
    telemetry?: Record<string, unknown>;
  }> {
    const snapshot = await this.supervisor.observeAttachedExecution(this.target, context);
    return {
      childStatus: snapshot.status,
      ...(snapshot.outcome ? { childOutcome: snapshot.outcome } : {}),
      ...(snapshot.lockDecision ? { childLockDecision: snapshot.lockDecision } : {}),
      ...(snapshot.telemetry ? { telemetry: snapshot.telemetry } : {}),
    };
  }
}

function mapManagerChildOutcome(status: StageStatus): string {
  if (status === StageStatus.SUCCESS) {
    return "success";
  }
  if (status === StageStatus.FAIL) {
    return "error";
  }
  if (status === StageStatus.PARTIAL_SUCCESS) {
    return "partial";
  }
  if (status === StageStatus.SKIPPED) {
    return "skipped";
  }
  return String(status);
}

function getAttachedExecutionSupervisor(
  backend: CodergenBackend | null | undefined,
): AttachedExecutionSupervisor | null {
  if (!backend) {
    return null;
  }
  return (backend as CapableBackend).asAttachedExecutionSupervisor?.() ?? null;
}

// Re-export RetryPolicy for the runner module
type RetryPolicy = import("./retry.js").RetryPolicy;
