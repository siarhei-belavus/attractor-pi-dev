import type { Graph, GraphNode } from "../model/graph.js";
import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";
import type { SteeringQueue } from "../steering/queue.js";
import type { ManagerChildExecution } from "../manager/child-execution.js";

/** Common interface for all node handlers */
export interface Handler {
  execute(
    node: GraphNode,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome>;
}

/** Backend interface for LLM/code generation tasks */
export interface CodergenBackend {
  run(node: GraphNode, prompt: string, context: Context): Promise<string | Outcome>;
}

/** Human interaction question model */
export enum QuestionType {
  YES_NO = "yes_no",
  MULTIPLE_CHOICE = "multiple_choice",
  FREEFORM = "freeform",
  CONFIRMATION = "confirmation",
}

export interface QuestionOption {
  key: string;
  label: string;
}

export enum AnswerValue {
  YES = "yes",
  NO = "no",
  SKIPPED = "skipped",
  TIMEOUT = "timeout",
  WAITING = "waiting",
  CONFIRMED = "confirmed",
  CANCELLED = "cancelled",
}

export interface Answer {
  value: string | AnswerValue;
  selectedOption?: QuestionOption;
  text?: string;
  questionId?: string;
}

export interface HumanPromptQuestion {
  key: string;
  text: string;
  type: QuestionType;
  options?: QuestionOption[];
  default?: string | AnswerValue;
  required?: boolean;
}

export interface HumanPrompt {
  title: string;
  stage: string;
  questions: HumanPromptQuestion[];
  metadata?: Record<string, unknown>;
}

export type HumanPromptAnswerMap = Record<string, Answer>;

export interface HumanPromptState {
  state: "answered" | "waiting" | "timeout" | "skipped";
  answers?: HumanPromptAnswerMap;
  promptId?: string;
}

/** Interface for all human interaction */
export interface Interviewer {
  ask(prompt: HumanPrompt): Promise<HumanPromptState>;
  inform?(message: string, stage: string): Promise<void>;
}

/** Child status as seen by the manager observer */
export type ChildStatus = "running" | "completed" | "failed";
export type ChildLockDecision = "resolved" | "reopen";

/** Result of an observe() call — telemetry snapshot from the child pipeline */
export interface ObserveResult {
  /** Current status of the child pipeline */
  childStatus: ChildStatus;
  /** Outcome string from the child (e.g. "success", "fail") when completed/failed */
  childOutcome?: string;
  /** Optional normalized supervisor decision for the child */
  childLockDecision?: ChildLockDecision;
  /** Additional telemetry data the observer gathered */
  telemetry?: Record<string, unknown>;
}

/** Observer interface for the ManagerLoopHandler's observe/steer cycle */
export interface ManagerObserver {
  /** Observe the child pipeline's current state and ingest telemetry into context */
  observe(context: Context): Promise<ObserveResult>;
}

export interface ManagerObserverFactoryInput {
  node: GraphNode;
  context: Context;
  graph: Graph;
  logsRoot: string;
  steeringQueue: SteeringQueue;
  childExecution: ManagerChildExecution;
  childRuntime?: ManagerChildRuntime;
}

export type ManagerObserverFactory =
  (input: ManagerObserverFactoryInput) => Promise<ManagerObserver | null | undefined> | ManagerObserver | null | undefined;

export interface ManagerChildRuntime {
  ensureChildExecution(context: Context): Promise<ManagerChildExecution>;
  startChildExecution(context: Context): Promise<void>;
}

export interface ManagerChildRuntimeFactoryInput {
  node: GraphNode;
  context: Context;
  graph: Graph;
  logsRoot: string;
  steeringQueue: SteeringQueue;
}

export type ManagerChildRuntimeFactory =
  (input: ManagerChildRuntimeFactoryInput) => Promise<ManagerChildRuntime | null | undefined> | ManagerChildRuntime | null | undefined;
