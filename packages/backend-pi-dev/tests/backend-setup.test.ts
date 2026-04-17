import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, BackendCallContext } from "@attractor/core";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import {
  loadBackendBootstrapFromSnapshot,
  resolveCurrentBackendBootstrap,
} from "../src/backend-setup.js";
import { Session } from "../src/session.js";

const tempDirs: string[] = [];
const capturedResourceLoaders: unknown[] = [];
const appliedActiveTools: string[][] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-backend-setup-"));
  tempDirs.push(dir);
  return dir;
}

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );

  class MockDefaultResourceLoader {
    constructor(public readonly opts: Record<string, unknown>) {}
    async reload(): Promise<void> {}
    getExtensions() {
      return { factories: [], diagnostics: [] };
    }
    getSkills() {
      return { skills: [], diagnostics: [] };
    }
    getPrompts() {
      return { prompts: [], diagnostics: [] };
    }
    getThemes() {
      return { themes: [], diagnostics: [] };
    }
    getAgentsFiles() {
      return { agentsFiles: [] };
    }
    getSystemPrompt() {
      return this.opts.systemPrompt as string | undefined;
    }
    getAppendSystemPrompt() {
      return [];
    }
    extendResources(): void {}
  }

  return {
    ...actual,
    DefaultResourceLoader: MockDefaultResourceLoader,
    createAgentSession: vi.fn(async (args: { resourceLoader: unknown }) => {
      capturedResourceLoaders.push(args.resourceLoader);
      const session = {
        bindExtensions: vi.fn(async () => undefined),
        subscribe: vi.fn(),
        getAllTools: () => [
          { name: "read" },
          { name: "edit" },
          { name: "apply_patch" },
          { name: "bash" },
        ],
        setActiveToolsByName: vi.fn((toolNames: string[]) => {
          appliedActiveTools.push([...toolNames]);
        }),
        getActiveToolNames: () => [],
        getLastAssistantText: () => "",
        messages: [],
        agent: {
          waitForIdle: async () => undefined,
        },
      };
      return { session };
    }),
  };
});

beforeEach(() => {
  capturedResourceLoaders.length = 0;
  appliedActiveTools.length = 0;
  vi.mocked(createAgentSession).mockClear();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("backend setup bootstrap resolution", () => {
  it("resolves backend_setup from workflow_base_dir and loads the default export callback", async () => {
    const tmpDir = makeTempDir();
    const workflowBaseDir = path.join(tmpDir, "workflow");
    const runRoot = path.join(tmpDir, "run");
    fs.mkdirSync(workflowBaseDir, { recursive: true });
    const modulePath = path.join(workflowBaseDir, "setup.mjs");
    fs.writeFileSync(modulePath, "export default async function setup() {}\n", "utf-8");

    const node: GraphNode = {
      id: "a",
      label: "a",
      shape: "box",
      type: "llm",
      prompt: "Do A",
      maxRetries: 0,
      goalGate: false,
      retryTarget: "",
      fallbackRetryTarget: "",
      fidelity: "compact",
      threadId: "shared-thread",
      contextKeys: [],
      classes: [],
      timeout: null,
      llmModel: "",
      llmProvider: "",
      reasoningEffort: "",
      autoStatus: false,
      allowPartial: false,
      attrs: {
        backend_setup: "${workflow_base_dir}/setup.mjs",
        cwd: "${run_root}/workspace",
      },
    };
    const backendCallContext: BackendCallContext = {
      runId: "run-1",
      logsRoot: runRoot,
      sessionRoot: path.join(runRoot, "sessions"),
      sessionAccessMode: "fresh",
      workflowBaseDir,
    };

    const bootstrap = await resolveCurrentBackendBootstrap({
      node,
      backendExecutionRef: "shared-thread",
      backendCallContext,
      defaultCwd: tmpDir,
    });

    expect(bootstrap.snapshot.cwd).toBe(path.join(runRoot, "workspace"));
    expect(bootstrap.snapshot.backendSetupPath).toBe(modulePath);
    expect(bootstrap.snapshot.backendSetupHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bootstrap.originalSetupRef).toBe("${workflow_base_dir}/setup.mjs");
    expect(bootstrap.resolvedSetupPath).toBe(modulePath);
    expect(bootstrap.setupCallback).toBeTypeOf("function");
    expect(bootstrap.backendStateRoot).toContain(path.join(runRoot, ".backend-pi-dev"));
  });

  it("keeps originalSetupRef nullable on reopen when only snapshot data is available", async () => {
    const tmpDir = makeTempDir();
    const workflowBaseDir = path.join(tmpDir, "workflow");
    const runRoot = path.join(tmpDir, "run");
    fs.mkdirSync(workflowBaseDir, { recursive: true });
    const modulePath = path.join(workflowBaseDir, "setup.mjs");
    fs.writeFileSync(modulePath, "export default async function setup() {}\n", "utf-8");
    const expectedHash = createHash("sha256")
      .update(fs.readFileSync(modulePath))
      .digest("hex");

    const bootstrap = await loadBackendBootstrapFromSnapshot({
      backendExecutionRef: "shared-thread",
      runRoot,
      workflowBaseDir,
      snapshot: {
        cwd: tmpDir,
        backendSetupPath: modulePath,
        backendSetupHash: expectedHash,
      },
    });

    expect(bootstrap.originalSetupRef).toBeNull();
    expect(bootstrap.resolvedSetupPath).toBe(modulePath);
  });

  it("fails reopen when the manifest-owned backend_setup hash drifts", async () => {
    const tmpDir = makeTempDir();
    const workflowBaseDir = path.join(tmpDir, "workflow");
    const runRoot = path.join(tmpDir, "run");
    fs.mkdirSync(workflowBaseDir, { recursive: true });
    const modulePath = path.join(workflowBaseDir, "setup.mjs");
    fs.writeFileSync(modulePath, "export default async function setup() {}\n", "utf-8");

    const originalHash = createHash("sha256")
      .update(fs.readFileSync(modulePath))
      .digest("hex");

    fs.writeFileSync(modulePath, "export default async function setup() { return 1; }\n", "utf-8");

    await expect(
      loadBackendBootstrapFromSnapshot({
        backendExecutionRef: "shared-thread",
        runRoot,
        workflowBaseDir,
        snapshot: {
          cwd: tmpDir,
          backendSetupPath: modulePath,
          backendSetupHash: originalHash,
        },
      }),
    ).rejects.toThrow(/backend_setup module drift detected/i);
  });
});

describe("session bootstrap setup callback", () => {
  it("lets setup replace the resource loader and seed initial tools before provider policy finalizes them", async () => {
    const tmpDir = makeTempDir();
    const customLoader = {
      async reload() {},
      getExtensions: () => ({ factories: [], diagnostics: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      extendResources: () => undefined,
    };
    const setupCalls: Array<{ mode: string; cwd: string; resolvedSetupPath: string | null }> = [];

    const session = new Session({
      profile: {
        id: "openai",
        model: { name: "test-model", contextWindow: 8192 } as any,
        tools: [],
        toolNames: ["read", "edit", "apply_patch", "bash"],
        defaultThinkingLevel: "medium",
        defaultCommandTimeoutMs: 1000,
        supportsParallelToolCalls: false,
        supportsReasoning: true,
        contextWindowSize: 8192,
        truncation: { charLimits: {}, lineLimits: {}, modes: {} },
        baseInstructions: "",
        projectDocPatterns: [],
      },
      bootstrap: {
        resolvedCwd: tmpDir,
        mode: "create",
        setupContext: {
          nodeId: "a",
          backendExecutionRef: "shared-thread",
          workflowBaseDir: tmpDir,
          runRoot: tmpDir,
          backendStateRoot: path.join(tmpDir, ".backend-pi-dev", "shared-thread"),
          originalSetupRef: "${workflow_base_dir}/setup.mjs",
          resolvedSetupPath: path.join(tmpDir, "setup.mjs"),
        },
        setupCallback: async (context, builder) => {
          setupCalls.push({
            mode: context.mode,
            cwd: context.cwd,
            resolvedSetupPath: context.resolvedSetupPath,
          });
          builder.setResourceLoader(customLoader as any);
          builder.setInitialActiveTools(["read", "edit", "apply_patch"]);
        },
      },
    });

    await session.initialize();

    expect(setupCalls).toEqual([
      {
        mode: "create",
        cwd: tmpDir,
        resolvedSetupPath: path.join(tmpDir, "setup.mjs"),
      },
    ]);
    expect(capturedResourceLoaders.at(-1)).toBe(customLoader);
    expect(appliedActiveTools.at(-1)).toEqual(["read", "apply_patch"]);
  });
});
