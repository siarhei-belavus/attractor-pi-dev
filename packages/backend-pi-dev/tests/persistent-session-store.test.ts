import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@attractor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentCodergenBackend } from "../src/backend.js";
import { PersistentSessionStore } from "../src/persistent-session-store.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("persistent session store", () => {
  it("reuses the same persisted session path for the same canonical backendExecutionRef", () => {
    const root = makeTempDir("pi-session-store-");
    const store = new PersistentSessionStore();

    const created = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: process.cwd(),
      backendSetupPath: "/tmp/workflow/setup.mjs",
      backendSetupHash: "hash-1",
      mode: "open_or_create",
      provider: "anthropic",
      model: "claude-test",
    });
    const firstManifest = store.commitAccess(created);
    fs.writeFileSync(firstManifest.sessionPath, "", "utf-8");

    const reopened = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: process.cwd(),
      mode: "open_required",
    });

    expect(reopened.sessionDir).toBe(created.sessionDir);
    expect(reopened.manifest.sessionPath).toBe(firstManifest.sessionPath);
    expect(reopened.manifest.cwd).toBe(process.cwd());
    expect(reopened.manifest.backendSetupPath).toBe("/tmp/workflow/setup.mjs");
    expect(reopened.manifest.backendSetupHash).toBe("hash-1");
  });

  it("isolates distinct canonical backendExecutionRefs into different directories", () => {
    const root = makeTempDir("pi-session-store-");
    const store = new PersistentSessionStore();

    const a = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "node-a",
      cwd: process.cwd(),
      mode: "open_or_create",
      provider: "anthropic",
      model: "claude-test",
    });
    const b = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "node-b",
      cwd: process.cwd(),
      mode: "open_or_create",
      provider: "anthropic",
      model: "claude-test",
    });

    expect(a.sessionDir).not.toBe(b.sessionDir);
  });

  it("fails fast on missing strict manifests", () => {
    const root = makeTempDir("pi-session-store-");
    const store = new PersistentSessionStore();

    expect(() =>
      store.resolve({
        sessionRoot: root,
        backendExecutionRef: "missing-ref",
        cwd: process.cwd(),
        mode: "open_required",
      }),
    ).toThrow(/manifest is missing/i);
  });

  it("fails fast on provider/model conflicts", () => {
    const root = makeTempDir("pi-session-store-");
    const store = new PersistentSessionStore();

    const created = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: process.cwd(),
      mode: "open_or_create",
      provider: "anthropic",
      model: "claude-test",
    });
    const manifest = store.commitAccess(created);
    fs.writeFileSync(manifest.sessionPath, "", "utf-8");

    expect(() =>
      store.resolve({
        sessionRoot: root,
        backendExecutionRef: "shared-thread",
        cwd: process.cwd(),
        mode: "open_or_create",
        provider: "openai",
        model: "gpt-test",
      }),
    ).toThrow(/locked to provider/i);
  });

  it("fails fast on bootstrap snapshot conflicts", () => {
    const root = makeTempDir("pi-session-store-");
    const store = new PersistentSessionStore();

    const created = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: process.cwd(),
      backendSetupPath: "/tmp/workflow/setup-a.mjs",
      backendSetupHash: "hash-a",
      mode: "open_or_create",
      provider: "anthropic",
      model: "claude-test",
    });
    const manifest = store.commitAccess(created);
    fs.writeFileSync(manifest.sessionPath, "", "utf-8");

    expect(() =>
      store.resolve({
        sessionRoot: root,
        backendExecutionRef: "shared-thread",
        cwd: path.join(process.cwd(), "other-cwd"),
        backendSetupPath: "/tmp/workflow/setup-b.mjs",
        backendSetupHash: "hash-b",
        mode: "open_or_create",
      }),
    ).toThrow(/locked to cwd|locked to backend_setup path|locked to backend_setup hash/i);
  });

  it("allows recreate to replace bootstrap drift instead of failing fast", () => {
    const root = makeTempDir("pi-session-store-");
    const store = new PersistentSessionStore();

    const created = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: process.cwd(),
      backendSetupPath: "/tmp/workflow/setup-a.mjs",
      backendSetupHash: "hash-a",
      mode: "open_or_create",
      provider: "anthropic",
      model: "claude-test",
    });
    const manifest = store.commitAccess(created);
    fs.writeFileSync(manifest.sessionPath, "", "utf-8");

    const recreated = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: path.join(process.cwd(), "other-cwd"),
      backendSetupPath: "/tmp/workflow/setup-b.mjs",
      backendSetupHash: "hash-b",
      mode: "recreate",
      provider: "openai",
      model: "gpt-test",
    });

    expect(recreated.manifest.cwd).toBe(path.join(process.cwd(), "other-cwd"));
    expect(recreated.manifest.provider).toBe("openai");
    expect(recreated.manifest.model).toBe("gpt-test");
    expect(recreated.manifest.backendSetupPath).toBe("/tmp/workflow/setup-b.mjs");
    expect(recreated.manifest.backendSetupHash).toBe("hash-b");
  });

  it("quarantines broken state and recreates in force mode", () => {
    const root = makeTempDir("pi-session-store-");
    const store = new PersistentSessionStore();

    const created = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: process.cwd(),
      backendSetupPath: "/tmp/workflow/setup-a.mjs",
      backendSetupHash: "hash-a",
      mode: "open_or_create",
      provider: "anthropic",
      model: "claude-test",
    });
    const manifest = store.commitAccess(created);
    fs.writeFileSync(manifest.sessionPath, "", "utf-8");
    fs.writeFileSync(path.join(created.sessionDir, "manifest.json"), "{broken", "utf-8");

    const recreated = store.resolve({
      sessionRoot: root,
      backendExecutionRef: "shared-thread",
      cwd: process.cwd(),
      backendSetupPath: "/tmp/workflow/setup-b.mjs",
      backendSetupHash: "hash-b",
      mode: "recreate",
      provider: "anthropic",
      model: "claude-test",
    });

    expect(recreated.sessionDir).toBe(created.sessionDir);
    expect(recreated.manifest.sessionPath).not.toBe(created.manifest.sessionPath);
    expect(recreated.manifest.backendSetupPath).toBe("/tmp/workflow/setup-b.mjs");
    expect(recreated.manifest.backendSetupHash).toBe("hash-b");
    expect(
      fs
        .readdirSync(root)
        .some((entry) => entry.includes(".quarantine.") && entry.includes("shared-thread")),
    ).toBe(true);
  });
});

describe("backend canonical resume policy", () => {
  it("uses node.threadId or node.id as the canonical persisted-session identity", () => {
    const backend = new PiAgentCodergenBackend() as any;

    expect(
      backend.resolveBackendExecutionRef({ id: "node-a", threadId: "shared-thread", classes: [] }),
    ).toBe("shared-thread");
    expect(
      backend.resolveBackendExecutionRef({ id: "node-b", threadId: "", classes: ["legacy-class"] }),
    ).toBe("node-b");
  });

  it("fails strict resume for pre-persistence checkpoints and normalizes force mode", () => {
    const backend = new PiAgentCodergenBackend() as any;
    const prePersistence = new Context();
    prePersistence.set("internal.last_completed_backend_execution_ref", "legacy-class");

    expect(() =>
      backend.resolveRunSessionMode(prePersistence, "node-b", "resume_strict"),
    ).toThrow(/predates persistent Pi sessions/i);
    expect(backend.resolveRunSessionMode(prePersistence, "node-b", "resume_force")).toBe(
      "recreate",
    );
  });

  it("requires reopen only when the resumed canonical ref already existed", () => {
    const backend = new PiAgentCodergenBackend() as any;
    const context = new Context();
    context.set("internal.backend_session_persistence", "pi_manifest_v1");
    context.set("internal.last_completed_backend_execution_ref", "shared-thread");

    expect(backend.resolveRunSessionMode(context, "shared-thread", "resume_strict")).toBe(
      "open_required",
    );
    expect(backend.resolveRunSessionMode(context, "shared-thread", "resume_force")).toBe(
      "recreate",
    );
    expect(backend.resolveRunSessionMode(context, "node-b", "resume_strict")).toBe(
      "open_or_create",
    );
  });

  it("fails fast when cached shared-thread sessions disagree on bootstrap snapshot", () => {
    const backend = new PiAgentCodergenBackend() as any;
    backend.sessionMetadata.set("run-1::shared-thread", {
      provider: "anthropic",
      modelId: "claude-test",
      cwd: "/tmp/workspace-a",
      backendSetupPath: "/tmp/workflow/setup-a.mjs",
      backendSetupHash: "hash-a",
    });

    expect(() =>
      backend.assertCachedSessionConsistency(
        "run-1::shared-thread",
        "anthropic",
        "claude-test",
        {
          cwd: "/tmp/workspace-b",
          backendSetupPath: "/tmp/workflow/setup-b.mjs",
          backendSetupHash: "hash-b",
        },
      ),
    ).toThrow(/locked to cwd|locked to backend_setup path|locked to backend_setup hash/i);
  });

  it("does not inject backend defaults before attached recreate can consult the manifest", async () => {
    const backend = new PiAgentCodergenBackend() as any;
    const context = new Context();
    context.set("internal.backend_session_persistence", "pi_manifest_v1");

    const calls: Array<Record<string, unknown>> = [];
    backend.createPersistentSession = vi.fn(async (args: Record<string, unknown>) => {
      calls.push(args);
      return { getRuntimeSnapshot() {}, setReasoningEffort() {} };
    });

    await backend.ensureAttachedSession(
      { backendExecutionRef: "child-thread" },
      context,
      {
        runId: "run-1",
        logsRoot: "/tmp/run-1",
        sessionRoot: "/tmp/run-1/sessions",
        sessionAccessMode: "resume_force",
        workflowBaseDir: null,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBeUndefined();
    expect(calls[0]?.modelId).toBeUndefined();
  });

  it("recreates cached sessions when resume_force is requested", async () => {
    const backend = new PiAgentCodergenBackend() as any;
    const dispose = vi.fn(async () => undefined);
    backend.sessions.set("run-1::shared-thread", {
      dispose,
      setReasoningEffort: vi.fn(),
    });
    backend.createPersistentSession = vi.fn(async () => ({
      dispose: vi.fn(async () => undefined),
      setReasoningEffort: vi.fn(),
    }));

    const context = new Context();
    context.set("internal.backend_session_persistence", "pi_manifest_v1");
    context.set("internal.last_completed_backend_execution_ref", "shared-thread");

    await backend.ensureRunSession({
      node: { id: "node-a", attrs: {} } as any,
      backendCallContext: {
        runId: "run-1",
        logsRoot: "/tmp/run-1",
        sessionRoot: "/tmp/run-1/sessions",
        sessionAccessMode: "resume_force",
        workflowBaseDir: null,
      },
      context,
      backendExecutionRef: "shared-thread",
      cacheKey: "run-1::shared-thread",
      provider: "anthropic",
      modelId: "claude-test",
      thinkingLevel: "high",
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(backend.createPersistentSession).toHaveBeenCalledTimes(1);
  });

  it("falls back to backend defaults only when attached recreate has no manifest-owned provider/model left", async () => {
    const backend = new PiAgentCodergenBackend({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5-20250929",
    }) as any;
    const context = new Context();
    context.set("internal.backend_session_persistence", "pi_manifest_v1");

    const calls: Array<Record<string, unknown>> = [];
    backend.createPersistentSession = vi.fn(async (args: Record<string, unknown>) => {
      calls.push(args);
      if (calls.length === 1) {
        throw new Error("Persistent session 'child-thread' cannot be recreated without provider and model");
      }
      return { getRuntimeSnapshot() {}, setReasoningEffort() {} };
    });

    await backend.ensureAttachedSession(
      { backendExecutionRef: "child-thread" },
      context,
      {
        runId: "run-1",
        logsRoot: "/tmp/run-1",
        sessionRoot: "/tmp/run-1/sessions",
        sessionAccessMode: "resume_force",
        workflowBaseDir: null,
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.provider).toBeUndefined();
    expect(calls[1]?.provider).toBe("anthropic");
    expect(calls[1]?.modelId).toBe("claude-sonnet-4-5-20250929");
  });
});
