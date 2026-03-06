import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonOrNull, writeJsonAtomic } from "../state/durable-json.js";

export type RunStatus =
  | "running"
  | "waiting_for_answer"
  | "completed"
  | "failed"
  | "cancelled";

export interface DurableRunState {
  runId: string;
  status: RunStatus;
  currentNode: string | null;
  completedNodes: string[];
  pendingQuestionId: string | null;
  updatedAt: string;
  error?: string;
}

export class RunStateStore {
  private readonly filePath: string;

  constructor(private readonly logsRoot: string) {
    this.filePath = path.join(logsRoot, "run-state.json");
  }

  load(): DurableRunState | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    const parsed = readJsonOrNull<Partial<DurableRunState>>(this.filePath);
    if (!parsed) {
      return null;
    }
    if (!parsed.runId || !parsed.status) {
      return null;
    }
    return {
      runId: parsed.runId,
      status: parsed.status,
      currentNode: parsed.currentNode ?? null,
      completedNodes: Array.isArray(parsed.completedNodes)
        ? parsed.completedNodes.map((value) => String(value))
        : [],
      pendingQuestionId: parsed.pendingQuestionId ?? null,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      ...(parsed.error ? { error: parsed.error } : {}),
    };
  }

  save(data: DurableRunState): void {
    fs.mkdirSync(this.logsRoot, { recursive: true });
    writeJsonAtomic(this.filePath, data);
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }
}
