export interface ToolPolicyResult {
  activeToolNames: string[];
  diagnostics: string[];
}

function isOpenAIProvider(providerId: string): boolean {
  const normalized = providerId.toLowerCase();
  return (
    normalized === "openai" ||
    normalized === "openai-codex" ||
    normalized === "azure-openai-responses"
  );
}

export function applyProviderToolActivationPolicy(
  providerId: string,
  availableToolNames: string[],
): ToolPolicyResult {
  const diagnostics: string[] = [];
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const toolName of availableToolNames) {
    if (seen.has(toolName)) {
      diagnostics.push(`Duplicate tool name detected: "${toolName}" (deduplicated).`);
      continue;
    }
    seen.add(toolName);
    deduped.push(toolName);
  }

  const openaiLike = isOpenAIProvider(providerId);
  const disableName = openaiLike ? "edit" : "apply_patch";
  const preferredName = openaiLike ? "apply_patch" : "edit";

  const hasDisable = deduped.includes(disableName);
  const hasPreferred = deduped.includes(preferredName);

  if (hasDisable && hasPreferred) {
    diagnostics.push(
      `Provider "${providerId}" tool policy deactivated "${disableName}" and kept "${preferredName}".`,
    );
  } else if (!hasPreferred) {
    diagnostics.push(
      `Provider "${providerId}" preferred tool "${preferredName}" is unavailable in active registry.`,
    );
  }

  const activeToolNames = deduped.filter((name) => name !== disableName);

  return { activeToolNames, diagnostics };
}
