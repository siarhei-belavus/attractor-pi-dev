import * as fs from "node:fs";
import * as path from "node:path";
import type { Outcome } from "./types.js";
import { readJsonOrThrow, writeJsonAtomic } from "./durable-json.js";

export interface CheckpointData {
  timestamp: string;
  currentNode: string;
  completedNodes: string[];
  nodeOutcomes: Record<string, Outcome>;
  nodeRetries: Record<string, number>;
  context: Record<string, unknown>;
  logs: string[];
  waitingForQuestionId?: string;
}

export class Checkpoint {
  timestamp: string;
  currentNode: string;
  completedNodes: string[];
  nodeOutcomes: Record<string, Outcome>;
  nodeRetries: Record<string, number>;
  contextValues: Record<string, unknown>;
  logs: string[];
  waitingForQuestionId?: string;

  constructor(opts?: Partial<CheckpointData>) {
    this.timestamp = opts?.timestamp ?? new Date().toISOString();
    this.currentNode = opts?.currentNode ?? "";
    this.completedNodes = opts?.completedNodes ?? [];
    this.nodeOutcomes = opts?.nodeOutcomes ?? {};
    this.nodeRetries = opts?.nodeRetries ?? {};
    this.contextValues = opts?.context ?? {};
    this.logs = opts?.logs ?? [];
    this.waitingForQuestionId = opts?.waitingForQuestionId;
  }

  save(logsRoot: string): void {
    const filePath = path.join(logsRoot, "checkpoint.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data: CheckpointData = {
      timestamp: new Date().toISOString(),
      currentNode: this.currentNode,
      completedNodes: this.completedNodes,
      nodeOutcomes: this.nodeOutcomes,
      nodeRetries: this.nodeRetries,
      context: this.contextValues,
      logs: this.logs,
      ...(this.waitingForQuestionId
        ? { waitingForQuestionId: this.waitingForQuestionId }
        : {}),
    };
    writeJsonAtomic(filePath, data);
  }

  static load(logsRoot: string): Checkpoint {
    const filePath = path.join(logsRoot, "checkpoint.json");
    const data = readJsonOrThrow<CheckpointData>(
      filePath,
      "Failed to load checkpoint JSON",
    );
    return new Checkpoint(data);
  }

  static exists(logsRoot: string): boolean {
    return fs.existsSync(path.join(logsRoot, "checkpoint.json"));
  }
}
