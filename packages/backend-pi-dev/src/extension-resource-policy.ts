import { isAbsolute } from "node:path";

export type ResourceDiscoveryMode = "auto" | "none";

export interface PiResourcePolicy {
  discovery: ResourceDiscoveryMode;
  allowlist: string[];
}

export interface PiResourcePolicyInput {
  discovery?: string | null;
  allowlist?: string[] | null;
}

const DEFAULT_POLICY: PiResourcePolicy = {
  discovery: "none",
  allowlist: [],
};

const DISCOVERY_ENV = "ATTRACTOR_PI_RESOURCE_DISCOVERY";
const ALLOWLIST_ENV = "ATTRACTOR_PI_RESOURCE_ALLOWLIST";

export function defaultPiResourcePolicy(): PiResourcePolicy {
  return { ...DEFAULT_POLICY, allowlist: [] };
}

export function parsePiResourcePolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  onWarning?: (message: string) => void,
): PiResourcePolicyInput {
  const out: PiResourcePolicyInput = {};

  const rawDiscovery = env[DISCOVERY_ENV]?.trim().toLowerCase();
  if (rawDiscovery) {
    if (rawDiscovery === "auto" || rawDiscovery === "none") {
      out.discovery = rawDiscovery;
    } else {
      onWarning?.(
        `Invalid ${DISCOVERY_ENV}=${JSON.stringify(env[DISCOVERY_ENV])}; using default "none".`,
      );
    }
  }

  const rawAllowlist = env[ALLOWLIST_ENV];
  if (rawAllowlist && rawAllowlist.trim().length > 0) {
    out.allowlist = parseAllowlist(rawAllowlist, `${ALLOWLIST_ENV}`, onWarning);
  }

  return out;
}

export function resolvePiResourcePolicy(
  runtime: PiResourcePolicyInput | undefined,
  env: PiResourcePolicyInput | undefined,
  onWarning?: (message: string) => void,
): PiResourcePolicy {
  const defaults = defaultPiResourcePolicy();
  const normalizedRuntime = normalizeInput(runtime, "runtime options", onWarning);
  const normalizedEnv = normalizeInput(env, "environment", onWarning);

  const discoveryCandidate =
    normalizedRuntime.discovery ?? normalizedEnv.discovery ?? defaults.discovery;
  const discovery: ResourceDiscoveryMode =
    discoveryCandidate === "none" ? "none" : "auto";

  return {
    discovery,
    allowlist:
      normalizedRuntime.allowlist ??
      normalizedEnv.allowlist ??
      defaults.allowlist,
  };
}

function normalizeInput(
  input: PiResourcePolicyInput | undefined,
  source: string,
  onWarning?: (message: string) => void,
): PiResourcePolicyInput {
  if (!input) return {};

  const out: PiResourcePolicyInput = {};

  if (input.discovery != null) {
    const value = input.discovery.trim().toLowerCase();
    if (value === "auto" || value === "none") {
      out.discovery = value as ResourceDiscoveryMode;
    } else {
      onWarning?.(
        `Invalid discovery value ${JSON.stringify(input.discovery)} in ${source}; expected "auto" or "none".`,
      );
    }
  }

  if (input.allowlist) {
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const item of input.allowlist) {
      const value = item.trim();
      if (!value) continue;
      if (!isAbsolute(value)) {
        onWarning?.(
          `Ignoring non-absolute extension path in ${source}: ${JSON.stringify(item)}`,
        );
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      valid.push(value);
    }
    out.allowlist = valid;
  }

  return out;
}

function parseAllowlist(
  value: string,
  sourceLabel: string,
  onWarning?: (message: string) => void,
): string[] {
  const entries = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const seen = new Set<string>();
  const valid: string[] = [];
  for (const entry of entries) {
    if (!isAbsolute(entry)) {
      onWarning?.(
        `Ignoring non-absolute extension path from ${sourceLabel}: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    valid.push(entry);
  }
  return valid;
}
