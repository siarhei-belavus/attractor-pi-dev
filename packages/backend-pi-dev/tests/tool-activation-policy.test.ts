import { describe, it, expect } from "vitest";
import { applyProviderToolActivationPolicy } from "../src/tool-activation-policy.js";

describe("applyProviderToolActivationPolicy", () => {
  it("keeps apply_patch and disables edit for openai providers", () => {
    const result = applyProviderToolActivationPolicy("openai", [
      "read",
      "edit",
      "apply_patch",
      "bash",
    ]);

    expect(result.activeToolNames).toEqual(["read", "apply_patch", "bash"]);
    expect(result.diagnostics.join("\n")).toContain("deactivated \"edit\"");
  });

  it("keeps edit and disables apply_patch for non-openai providers", () => {
    const result = applyProviderToolActivationPolicy("anthropic", [
      "read",
      "edit",
      "apply_patch",
      "bash",
    ]);

    expect(result.activeToolNames).toEqual(["read", "edit", "bash"]);
    expect(result.diagnostics.join("\n")).toContain("deactivated \"apply_patch\"");
  });

  it("deduplicates tool names with diagnostics", () => {
    const result = applyProviderToolActivationPolicy("openai-codex", [
      "read",
      "read",
      "apply_patch",
      "edit",
    ]);

    expect(result.activeToolNames).toEqual(["read", "apply_patch"]);
    expect(result.diagnostics.join("\n")).toContain("Duplicate tool name");
  });
});
