import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, runCommand } from "../src/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-cli-run-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runCommand resume semantics", () => {
  it("reuses the same run root and run id when --resume-from is passed without --logs-dir", async () => {
    const tmpDir = makeTempDir();
    const dotPath = path.join(tmpDir, "workflow.dot");
    const resumeFrom = path.join(tmpDir, "existing-run");
    fs.mkdirSync(resumeFrom, { recursive: true });
    fs.writeFileSync(
      dotPath,
      `
        digraph RunCommand {
          graph [goal="resume"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A"]
          start -> a -> exit
        }
      `,
    );

    let seenContext: { runId: string; logsRoot: string; sessionAccessMode: string } | null = null;
    await runCommand([dotPath, "--resume-from", resumeFrom], {
      createBackend: () => ({
        async run(_node, _prompt, _context, backendCallContext) {
          seenContext = {
            runId: backendCallContext.runId,
            logsRoot: backendCallContext.logsRoot,
            sessionAccessMode: backendCallContext.sessionAccessMode,
          };
          return "done";
        },
      }),
    });

    expect(seenContext).toEqual({
      runId: path.basename(resumeFrom),
      logsRoot: resumeFrom,
      sessionAccessMode: "resume_strict",
    });
  });

  it("treats a different --logs-dir alongside --resume-from as an explicit fork", async () => {
    const tmpDir = makeTempDir();
    const dotPath = path.join(tmpDir, "workflow.dot");
    const resumeFrom = path.join(tmpDir, "existing-run");
    const logsDir = path.join(tmpDir, "forked-run");
    fs.mkdirSync(resumeFrom, { recursive: true });
    fs.writeFileSync(
      dotPath,
      `
        digraph RunCommand {
          graph [goal="resume"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A"]
          start -> a -> exit
        }
      `,
    );

    let seenContext: { runId: string; logsRoot: string; sessionAccessMode: string } | null = null;
    await runCommand([dotPath, "--resume-from", resumeFrom, "--logs-dir", logsDir], {
      createBackend: () => ({
        async run(_node, _prompt, _context, backendCallContext) {
          seenContext = {
            runId: backendCallContext.runId,
            logsRoot: backendCallContext.logsRoot,
            sessionAccessMode: backendCallContext.sessionAccessMode,
          };
          return "done";
        },
      }),
    });

    expect(seenContext).toEqual({
      runId: path.basename(logsDir),
      logsRoot: logsDir,
      sessionAccessMode: "resume_strict",
    });
  });

  it("keeps --force scoped to reopen mode while preserving same-run default logsRoot", async () => {
    const tmpDir = makeTempDir();
    const dotPath = path.join(tmpDir, "workflow.dot");
    const resumeFrom = path.join(tmpDir, "existing-run");
    fs.mkdirSync(resumeFrom, { recursive: true });
    fs.writeFileSync(
      dotPath,
      `
        digraph RunCommand {
          graph [goal="resume"]
          start [shape=Mdiamond]
          exit [shape=Msquare]
          a [prompt="Do A"]
          start -> a -> exit
        }
      `,
    );

    let seenContext: { runId: string; logsRoot: string; sessionAccessMode: string } | null = null;
    await runCommand([dotPath, "--resume-from", resumeFrom, "--force"], {
      createBackend: () => ({
        async run(_node, _prompt, _context, backendCallContext) {
          seenContext = {
            runId: backendCallContext.runId,
            logsRoot: backendCallContext.logsRoot,
            sessionAccessMode: backendCallContext.sessionAccessMode,
          };
          return "done";
        },
      }),
    });

    expect(seenContext).toEqual({
      runId: path.basename(resumeFrom),
      logsRoot: resumeFrom,
      sessionAccessMode: "resume_force",
    });
  });

  it("prints help text that documents same-run resume defaults", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(main(["--help"])).rejects.toThrow("exit:0");

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("or --resume-from path when resuming");
    expect(output).toContain("continue in that same run unless --logs-dir overrides it");
  });
});
