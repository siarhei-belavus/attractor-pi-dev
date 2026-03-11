import * as fs from "node:fs";
import * as path from "node:path";
import type { DebugEvent, DebugSnapshot, DebugTelemetrySink } from "@attractor/core";

export function createDebugAgentWriter(logsRoot: string): DebugTelemetrySink {
  fs.mkdirSync(logsRoot, { recursive: true });

  return {
    writeEvent(event: DebugEvent) {
      const threadDir = path.join(logsRoot, "debug", "threads", sanitizePathSegment(event.data.sessionKey));
      fs.mkdirSync(threadDir, { recursive: true });
      const threadPath = path.join(threadDir, "session-events.jsonl");
      const payload = {
        timestamp: new Date().toISOString(),
        event,
      };
      fs.appendFileSync(threadPath, `${JSON.stringify(redactDebugPayload(payload))}\n`);
    },
    writeSnapshot(snapshot: DebugSnapshot) {
      const threadDir = path.join(logsRoot, "debug", "threads", sanitizePathSegment(snapshot.sessionKey));
      fs.mkdirSync(threadDir, { recursive: true });

      const artifactDir = snapshot.nodeId
        ? path.join(logsRoot, sanitizePathSegment(snapshot.nodeId))
        : threadDir;
      fs.mkdirSync(artifactDir, { recursive: true });

      if (snapshot.promptText !== undefined) {
        fs.writeFileSync(path.join(artifactDir, "system-prompt.md"), snapshot.promptText);
      }
      if (snapshot.activeTools) {
        fs.writeFileSync(
          path.join(artifactDir, "active-tools.json"),
          JSON.stringify(
            redactDebugPayload({
              generatedAt: new Date().toISOString(),
              phase: snapshot.phase,
              sessionKey: snapshot.sessionKey,
              nodeId: snapshot.nodeId,
              provider: snapshot.provider,
              modelId: snapshot.modelId,
              activeTools: snapshot.activeTools,
              diagnostics: snapshot.diagnostics,
            }),
            null,
            2,
          ),
        );
      }

      fs.writeFileSync(
        path.join(threadDir, "latest-snapshot.json"),
        JSON.stringify(redactDebugPayload(snapshot), null, 2),
      );
    },
  };
}

function sanitizePathSegment(input: unknown): string {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value.replace(/[\\/]/g, "_") : "unknown";
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
