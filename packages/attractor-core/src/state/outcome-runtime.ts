import type { Context } from "./context.js";
import type { Outcome } from "./types.js";

export function applyOutcomeRuntimeContext(
  context: Context,
  outcome: Outcome,
): void {
  context.set("outcome", outcome.status);
  if (outcome.failureReason) {
    context.set("failure.reason", outcome.failureReason);
  }
  if (outcome.preferredLabel) {
    context.set("preferred_label", outcome.preferredLabel);
  }
}
