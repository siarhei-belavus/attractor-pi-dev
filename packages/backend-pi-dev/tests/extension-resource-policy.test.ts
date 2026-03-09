import { describe, it, expect } from "vitest";
import {
  parsePiResourcePolicyFromEnv,
  resolvePiResourcePolicy,
} from "../src/extension-resource-policy.js";

describe("parsePiResourcePolicyFromEnv", () => {
  it("parses valid env policy values", () => {
    const warnings: string[] = [];
    const parsed = parsePiResourcePolicyFromEnv(
      {
        ATTRACTOR_PI_RESOURCE_DISCOVERY: "none",
        ATTRACTOR_PI_RESOURCE_ALLOWLIST: "/abs/a.ts,/abs/b.ts",
      },
      (warning) => warnings.push(warning),
    );

    expect(parsed.discovery).toBe("none");
    expect(parsed.allowlist).toEqual(["/abs/a.ts", "/abs/b.ts"]);
    expect(warnings).toEqual([]);
  });

  it("warns and ignores invalid values", () => {
    const warnings: string[] = [];
    const parsed = parsePiResourcePolicyFromEnv(
      {
        ATTRACTOR_PI_RESOURCE_DISCOVERY: "invalid",
        ATTRACTOR_PI_RESOURCE_ALLOWLIST: "relative.ts,/abs/good.ts",
      },
      (warning) => warnings.push(warning),
    );

    expect(parsed.discovery).toBeUndefined();
    expect(parsed.allowlist).toEqual(["/abs/good.ts"]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("resolvePiResourcePolicy", () => {
  it("applies precedence runtime > env > defaults", () => {
    const resolved = resolvePiResourcePolicy(
      {
        discovery: "none",
        allowlist: ["/runtime/a.ts"],
      },
      {
        discovery: "auto",
        allowlist: ["/env/a.ts"],
      },
    );

    expect(resolved.discovery).toBe("none");
    expect(resolved.allowlist).toEqual(["/runtime/a.ts"]);
  });

  it("falls back to defaults when values are missing", () => {
    const resolved = resolvePiResourcePolicy(undefined, undefined);
    expect(resolved.discovery).toBe("auto");
    expect(resolved.allowlist).toEqual([]);
  });
});
