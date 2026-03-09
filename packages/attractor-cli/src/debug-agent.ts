import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionEvent, SessionSnapshot } from "@attractor/backend-pi-dev";

export interface DebugAgentWriter {
  writeEvent: (event: SessionEvent) => void;
  writeSnapshot: (snapshot: SessionSnapshot) => void;
}

export function createDebugAgentWriter(logsRoot: string): DebugAgentWriter {
  fs.mkdirSync(logsRoot, { recursive: true });

  const threadPath = path.join(logsRoot, "agent-thread.jsonl");
  const promptPath = path.join(logsRoot, "system-prompt.md");
  const toolsPath = path.join(logsRoot, "active-tools.json");

  return {
    writeEvent(event) {
      const payload = {
        timestamp: new Date().toISOString(),
        event,
      };
      fs.appendFileSync(threadPath, `${JSON.stringify(redactDebugPayload(payload))}\n`);
    },
    writeSnapshot(snapshot) {
      fs.writeFileSync(promptPath, snapshot.systemPrompt || "");
      fs.writeFileSync(
        toolsPath,
        JSON.stringify(
          redactDebugPayload({
            generatedAt: new Date().toISOString(),
            phase: snapshot.phase,
            threadKey: snapshot.threadKey,
            provider: snapshot.provider,
            modelId: snapshot.modelId,
            activeTools: snapshot.activeTools,
            toolPolicyDiagnostics: snapshot.toolPolicyDiagnostics,
          }),
          null,
          2,
        ),
      );
    },
  };
}

export function redactDebugPayload(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactDebugPayload(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/api[_-]?key|token|secret|password|authorization|cookie/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactDebugPayload(nested);
      }
    }
    return out;
  }
  return value;
}

export function redactString(input: string): string {
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}
