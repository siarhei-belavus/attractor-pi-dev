import { BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY } from "../../backend/contracts.js";
import { Context } from "../../state/context.js";

export function preserveBackendRuntimeContext(source: Context, backendContext: Context): void {
  syncContextKey(backendContext, source, "internal.run_id");
  syncContextKey(backendContext, source, "internal.current_node_id");
  syncContextKey(backendContext, source, "internal.current_branch_key");
  syncContextKey(backendContext, source, "internal.thread_key");
  syncContextKey(backendContext, source, "internal.manager_child_execution_id");
  syncContextKey(backendContext, source, BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY);
}

export function syncBackendExecutionContext(source: Context, backendContext: Context): void {
  syncContextKey(source, backendContext, "internal.current_backend_execution_ref");
  syncContextKey(source, backendContext, "internal.last_completed_backend_execution_ref");
  syncContextKey(source, backendContext, BACKEND_SESSION_PERSISTENCE_CONTEXT_KEY);
}

function syncContextKey(target: Context, source: Context, key: string): void {
  const value = source.getString(key);
  if (value) {
    target.set(key, value);
  } else {
    target.delete(key);
  }
}
