import { describe, expect, it } from "vitest";
import { runGoldenScenario } from "./cli-golden-harness.js";

describe("cli golden harness", () => {
  it("uses a narrow run snapshot contract", async () => {
    const snapshot = await runGoldenScenario("simple-linear-success");

    expect(snapshot.run).not.toHaveProperty("manifest");
    expect(snapshot.run.artifacts).not.toHaveProperty("prompts");
    expect(snapshot.run.artifacts).not.toHaveProperty("responses");
    expect(snapshot.run.artifacts.nodeStatus).toEqual({
      implement: { status: "success" },
      plan: { status: "success" },
      start: { status: "success" },
    });
  }, 30_000);

  it("preserves user-visible warnings while dropping timestamped event logs", async () => {
    const snapshot = await runGoldenScenario("warning-visible");

    expect(snapshot.cli.stderr).toContain(
      "[WARN] [prompt_on_llm_nodes] LLM node 'work' has no prompt and label is the same as ID",
    );
    expect(snapshot.cli.stdout.some((line) => /^\[\d{1,2}:\d{2}:\d{2}/u.test(line))).toBe(false);
  }, 30_000);

  it("uses the terminal failure reason after resume instead of stale checkpoint history", async () => {
    const snapshot = await runGoldenScenario("resume-fail-after-resume");

    expect(snapshot.cli.stderr).toContain("Failure: No tool_command specified");
    expect(snapshot.run.outcome.failureReason).toBe("No tool_command specified");
  }, 30_000);
});
