# Backend Abstraction Refactor Plan

## Objective

Restore the intended layering between `@attractor/core`, `@attractor/cli`, and `@attractor/backend-pi-dev` so the CLI depends only on backend-agnostic contracts and optional capabilities, not pi-specific session internals.

## Scope

In scope:

- Remove direct `@attractor/backend-pi-dev` type coupling from `@attractor/cli`.
- Replace hidden backend extension points with explicit capabilities.
- Introduce backend-agnostic debug telemetry contracts.
- Move pi-specific operational details out of generic CLI-facing contracts and docs.

Out of scope:

- Reworking session internals inside `backend-pi-dev` beyond the minimum changes required to implement the new adapter contracts.
- Changing pipeline semantics or node execution behavior.
- Redesigning the HTTP API beyond capability plumbing already required by this refactor.

## Implementation Handoff Notes

This plan is intended to be executable by an implementer who does not have access to the originating conversation.

Start from these primary change points:

- `packages/attractor-core`
- `packages/attractor-cli`
- `packages/backend-pi-dev`
- `docs/user/cli-reference.md`
- `docs/user/cookbook.md`

Treat the following as transitional names or structures that should not survive the final refactor:

- `executionId` when it refers to an adapter-owned execution handle
- `adapterTarget` as a loose catch-all bag for attached execution metadata
- direct CLI imports from `@attractor/backend-pi-dev`
- duck-typed `createManagerObserverFactory()`
- CLI-facing dependence on `SessionSnapshot` / `SessionEvent`

Expected compatibility strategy during implementation:

1. Introduce the new generic contracts first.
2. Migrate in-repo callers directly to the new contracts.
3. Remove legacy names and structures in the same refactor series once replacements exist.

Do not assume that the current implementation names reflect the intended target architecture. Use the target types and terminology defined in this document as the source of truth for the migration.

No backward-compatibility guarantee is required for this refactor. This project is not yet constrained by a production compatibility contract, so the preferred strategy is an in-place update to the correct model rather than preserving legacy names or dual paths longer than necessary.

## Current Problems

1. `@attractor/cli` imports `PiAgentCodergenBackend`, `PiAgentBackendOptions`, `SessionEvent`, and `SessionSnapshot` directly.
2. Debug artifact writing is coupled to pi-specific concepts such as `threadKey`, `systemPrompt`, and `activeTools`.
3. Manager observer support is discovered with duck typing instead of an explicit interface.
4. CLI docs expose pi-specific environment variables and extension behavior as if they were generic runtime features.
5. The current setup makes it harder to add a second backend without either leaking more backend details upward or duplicating CLI logic.
6. `ManagerChildExecution` currently conflates two different concepts:
   - a managed child pipeline from the Attractor spec
   - an attached backend-owned execution target
7. The name `executionId` is too generic for what is currently an opaque adapter/backend handle.
8. `@attractor/core` currently derives `internal.current_execution_id` and `internal.last_completed_execution_id` from thread-key resolution, which conflates session reuse semantics with backend-owned execution identity.
9. `SteeringTarget.executionId` makes a backend-owned concept look like a generic orchestration identifier in core APIs.
10. Core tests and examples already treat pi-specific telemetry keys such as `thread_key` and `session_state` as if they were part of the generic manager-loop model.
11. The leak has escaped internal code and now appears in public package exports, HTTP responses, persisted context/checkpoint state, and golden fixtures.

## Success Criteria

The refactor is done when all of the following are true:

- `@attractor/cli` no longer imports from `@attractor/backend-pi-dev`.
- CLI backend construction uses backend-agnostic factory options.
- Debug telemetry is modeled through a generic contract and degrades cleanly when unsupported.
- Attached backend execution supervision uses an explicit capability or interface, not method probing.
- Thread/session reuse semantics are no longer used as a proxy for backend-managed execution identity.
- `@attractor/core` no longer presents backend-owned execution handles as generic orchestration IDs.
- Pi-specific environment variables and behavior are documented in backend-specific docs, not generic CLI docs.
- Public/core exported types, HTTP server payloads, and persisted run/checkpoint state no longer expose the old backend-shaped execution model.
- Existing CLI tests still pass, and new tests cover the capability boundaries.

## Proposed Architecture

### 0. Align the model with the Attractor specification

The Attractor specification describes manager-loop supervision over a child pipeline.

The current implementation extends that model by allowing the manager to attach to an existing backend-managed execution. That extension is useful, but it should be modeled explicitly instead of overloading the meaning of "child execution".

Adopt these semantic rules:

- `ManagedChildPipeline` means a child pipeline started or supervised as a pipeline-level entity.
- `AttachedBackendExecution` means an external backend-owned execution target that can be observed and steered.

Do not preserve the current loose `ManagerChildExecution` shape as the final model. Replace it with the explicit discriminated-union model in this plan.

To make the intended direction executable for a fresh implementation pass, the target model is specified concretely below and should be implemented as written.

Use these target shapes:

```ts
export interface AttachedExecutionTarget {
  backendExecutionRef: string;
  branchKey?: string;
  nodeId?: string;
}

export interface AttachedExecutionSnapshot {
  status: "running" | "completed" | "failed";
  outcome?: string;
  lockDecision?: "resolved" | "reopen";
  telemetry?: Record<string, unknown>;
}

export interface AttachedExecutionSupervisor {
  observeAttachedExecution(
    target: AttachedExecutionTarget,
    context: Context,
  ): Promise<AttachedExecutionSnapshot>;

  steerAttachedExecution(
    target: AttachedExecutionTarget,
    message: string,
    context: Context,
  ): Promise<void>;
}
```

Use this child execution model:

```ts
export type ManagerChildExecution =
  | {
      id: string;
      runId: string;
      ownerNodeId: string;
      kind: "managed_pipeline";
      autostart: boolean;
      dotfile: string;
    }
  | {
      id: string;
      runId: string;
      ownerNodeId: string;
      kind: "attached_backend_execution";
      autostart: false;
      attachedTarget: AttachedExecutionTarget;
    };
```

This discriminated-union shape is preferred over a single loose interface because it prevents invalid states such as:

- attached executions with `dotfile`
- managed child pipelines with backend-only handles
- attached executions marked as autostartable by the core runner

### 1. Core owns the contracts

Add backend-agnostic contracts in `@attractor/core` for:

- backend factory options used by CLI and server entrypoints
- optional backend capabilities
- debug telemetry sink/event/snapshot shapes
- attached backend execution support that is clearly separate from thread/session reuse

Implement the following contracts:

```ts
interface BackendFactoryOptions {
  cwd: string;
  provider?: string;
  model?: string;
  steeringQueue?: SteeringQueue;
  debugSink?: DebugTelemetrySink;
  warningSink?: (message: string) => void;
}

interface BackendCapabilities {
  debugTelemetry?: boolean;
  attachedExecutionSupervision?: boolean;
}

interface DebugSnapshot {
  phase: "before_submit" | "after_submit";
  sessionKey: string;
  promptText?: string;
  activeTools?: string[];
  diagnostics?: string[];
  provider?: string;
  modelId?: string;
}

interface DebugEvent {
  kind: string;
  timestamp: number;
  data: Record<string, unknown>;
}

interface CapableBackend extends CodergenBackend {
  getCapabilities?(): BackendCapabilities;
  asAttachedExecutionSupervisor?(): AttachedExecutionSupervisor | null;
}
```

### 2. Backend adapters implement the contracts

`@attractor/backend-pi-dev` is responsible for:

- mapping its `Session` internals into generic `DebugSnapshot` and `DebugEvent`
- advertising supported capabilities
- implementing attached backend execution supervision using the generic capability/interface

Keep pi-specific fields such as `threadKey` internal to `backend-pi-dev`. Do not expose them as required generic fields in core, CLI, server payloads, or golden expectations.

Use `backendExecutionRef` instead of `executionId` wherever the value refers to an opaque backend/adapter-owned execution handle.

Naming rule:

- `runId` remains an Attractor run identifier
- `nodeId` remains a pipeline node identifier
- `thread_id` remains a session/thread reuse key in fidelity semantics
- `backendExecutionRef` means an opaque reference understood only by the backend adapter

This naming is intentionally explicit: the value is not a generic execution identifier for the whole system, and it should not be mistaken for a pipeline run ID or a node execution ID.

### 3. Separate thread/session semantics from attached execution identity

The current implementation reuses the output of thread-key resolution as `internal.current_execution_id` and `internal.last_completed_execution_id`. That coupling must be removed.

Required semantic split:

- `thread_id` and resolved thread keys belong to fidelity/session-reuse logic only
- `backendExecutionRef` belongs to attached backend execution supervision only
- a backend may internally choose the same string for both, but core, CLI, tests, and docs must not rely on that coincidence

Implementation rule:

- `@attractor/core` must not synthesize `backendExecutionRef` from `thread_id`, `default_thread`, subgraph class, or previous node ID
- if attached backend supervision is needed, the backend adapter must provide the reference explicitly

Use this internal state split:

```text
internal.thread_key
internal.last_completed_thread_key
internal.current_backend_execution_ref
internal.last_completed_backend_execution_ref
```

Use these exact context key names. Do not introduce alternate names for the same concepts.

### 4. Treat public exports, HTTP payloads, and persisted state as part of the refactor surface

The abstraction leak is not limited to internal code. It already appears in places that other code or tools could consume:

- `@attractor/core` public exports
- HTTP server responses
- persisted checkpoint/context state
- golden fixtures and test seeds

That means the refactor must update these surfaces intentionally, not as cleanup after the main code changes.

Required actions:

- remove or rename backend-shaped exported types in `@attractor/core`
- stop returning legacy backend-shaped target fields from generic HTTP APIs; return only fields from the new explicit target contract
- stop persisting backend execution handles under thread-derived or misleadingly generic names
- update golden seeds and snapshots so they validate the new abstraction boundary instead of the old pi-shaped model

### 5. CLI consumes only generic capabilities

`@attractor/cli` must:

- accept a generic backend factory from `CliDeps`
- create a generic debug sink when `--debug-agent` is enabled
- ask the backend whether debug telemetry is supported
- ask the backend whether attached execution supervision is supported before attempting backend-managed attach behavior
- warn and continue without debug artifacts when `debugTelemetry` is unsupported
- fail fast with a clear error when attached backend execution supervision is requested but unsupported

The CLI must not know what a pi session is, how prompts are assembled, or which env vars affect a backend implementation.

### 6. Debug artifact layout should distinguish node-level from thread-level data

Do not treat `thread_id` and `nodeId` as interchangeable.

- `thread_id` identifies a shared LLM session or conversation context.
- `nodeId` identifies a specific pipeline stage execution.

Because multiple nodes may intentionally share the same `thread_id`, debug artifacts must be split by meaning:

- node-level artifacts belong under the node directory
- session/thread-level artifacts belong under a thread-specific debug directory

Use this layout:

```text
<logsRoot>/
  <nodeId>/
    prompt.md
    response.md
    status.json
    system-prompt.md
    active-tools.json
  debug/
    threads/
      <sessionKey>/
        session-events.jsonl
        latest-snapshot.json
```

Rules:

1. Write `system-prompt.md` to the node folder when `nodeId` is known.
2. Write `active-tools.json` to the node folder when it reflects the tool set active for that node execution.
3. Keep long-lived session history such as `session-events.jsonl` under a thread/session-scoped folder.
4. If `nodeId` is unavailable, write `system-prompt.md` and `active-tools.json` under `debug/threads/<sessionKey>/`.

This preserves the existing run-log mental model:

- node directories answer "what happened in this stage?"
- thread directories answer "what happened in this shared conversation?"

### 7. Steering and observability invariants must be preserved

This refactor must preserve the user-facing behavior of steering and manager-loop observability while changing how targets are modeled internally.

Steering invariants:

- if the active target is an `attached_backend_execution`, steering must be delivered to the live backend-managed execution identified by `backendExecutionRef`
- if there is no attached backend execution, steering must continue to follow the normal Attractor execution path and be consumable by the next matching LLM node/execution scope
- steering delivery must be selected by explicit target kind and capability, not by assuming that thread/session identity is the execution handle

Observability invariants:

- `managed_pipeline` uses core-owned observability based on the child pipeline runtime
- `attached_backend_execution` uses backend-provided observability based on the backend-managed execution
- both paths must feed the same manager-loop-level contract for status and telemetry
- generic consumers must not require pi-specific telemetry keys such as `thread_key`, `session_state`, or `last_assistant_text`

This means the refactor changes addressing and ownership boundaries, but it must not regress the practical behavior of:

- steering a live backend-managed child execution
- observing a live backend-managed child execution
- observing a core-managed child pipeline
- steering normal non-attached pipeline execution

## Execution Plan

### Phase 1: Introduce generic contracts without breaking behavior

1. Add generic backend capability and debug telemetry types to `@attractor/core`.
2. Add a generic backend factory options type for CLI/server usage.
3. Rename `executionId` to `backendExecutionRef` at the core contract boundary instead of preserving both names.
4. Replace loose `adapterTarget` modeling with the explicit target shapes from this plan.
5. Document the target `ManagerChildExecution` discriminated union in code comments or type docs so a fresh implementer does not have to reverse-engineer intent from old fields.
6. Introduce a separate state path for backend-managed execution references before changing attached supervision behavior.

Why first:

- This creates the target seam before any wiring changes.
- It keeps the rest of the refactor additive and reviewable.

### Phase 2: Move CLI onto generic contracts

1. Update `CliDeps.createBackend` to accept generic factory options.
2. Replace direct imports from `@attractor/backend-pi-dev` in `@attractor/cli`.
3. Convert `debug-agent.ts` to operate on generic debug types.
4. Replace manager observer duck typing with an explicit capability/interface check.
5. Preserve user-visible steering and observability behavior while removing legacy names and legacy artifact placement.
6. Ensure CLI and server code can reason about `managed_pipeline` and `attached_backend_execution` without knowing backend internals.
7. Update HTTP payloads and run-state exposure to use the new explicit terms instead of leaking legacy execution fields.

Why second:

- This removes the main abstraction leak at the package boundary.
- The CLI becomes reusable across backends before backend internals are cleaned up further.

### Phase 3: Adapt `backend-pi-dev`

1. Add a thin adapter layer from pi session events/snapshots to generic debug telemetry.
2. Include `nodeId` in emitted debug snapshots whenever the current node execution is known.
3. Expose capability reporting for debug telemetry and attached execution supervision.
4. Keep pi-only policy and extension logic inside `backend-pi-dev`.
5. Preserve debug semantics while emitting generic shapes and writing artifacts to the new node-level layout.
6. Rename internal/external adapter handle usage from `executionId` to `backendExecutionRef`.
7. Implement `AttachedExecutionSupervisor` as the pi-backed adapter for backend-managed session observe/steer behavior.
8. Make any mapping from pi session identity to `backendExecutionRef` an adapter concern, not a core concern.

Why third:

- The backend can migrate after the generic contracts exist and after the CLI is ready to consume them.
- This reduces the risk of changing both sides blindly at once.

### Phase 4: Clean up docs and public surface

1. Remove pi-specific environment variables from generic CLI documentation.
2. Add a backend-specific docs section for pi resource policy and extension behavior.
3. Document the capability model:
   - what `--debug-agent` does when supported
   - what happens when it is unsupported
   - what attached backend execution supervision requires
4. Document any generic debug artifact layout adopted during the refactor.
5. Document explicitly that attached backend execution supervision is an implementation extension beyond the spec's default child-pipeline model.
6. Update any language-spec or server docs that currently imply the old execution-handle semantics.

Why fourth:

- Docs should follow the stabilized contract, not the transitional one.

### Phase 5: Remove compatibility debt

1. Delete pi-specific types from CLI-facing surfaces.
2. Remove old callback names if superseded by generic equivalents.
3. Tighten tests so cross-package leaks fail loudly in the future.
4. Remove any remaining `adapterTarget.executionId` naming in favor of `backendExecutionRef`.
5. Remove any remaining core code that writes or reads backend execution handles through thread-derived fields.
6. Remove any fixture or exported API shape that still reflects the legacy model.

Why last:

- This keeps the migration safe and avoids premature deletions.

## Validation Plan

### Compile-time checks

- `@attractor/cli` builds with no imports from `@attractor/backend-pi-dev`.
- `@attractor/backend-pi-dev` builds against the new generic contracts.
- `@jhugman/attractor-pi` still bundles correctly.

### Tests to add or update

- CLI unit test proving it can run with a backend stub that only implements generic contracts.
- CLI unit test proving `--debug-agent` degrades gracefully when debug telemetry is unsupported.
- CLI unit test proving attached backend execution supervision is gated by explicit capability, not duck typing.
- Core/runner unit test proving `managed_pipeline` and `attached_backend_execution` take different execution paths.
- Core/runner unit test proving thread-key resolution does not implicitly populate backend execution references.
- Backend adapter test proving pi session snapshots map correctly into generic debug snapshots.
- Regression test proving the pi backend still generates debug artifacts under the new node-level layout and thread-level history layout.
- Backend capability test proving a backend can opt in to attached execution supervision without exposing pi-specific types.
- Test coverage proving generic manager-loop behavior does not require pi-specific telemetry keys such as `thread_key` or `session_state`.
- Server/API test proving queued steering responses and checkpoint payloads no longer expose legacy execution-handle names.
- Export-surface test or lint check proving `@attractor/core` no longer exports the legacy attached-execution shape.

### Golden dataset expectations

Remove golden coverage that locks in pi-specific behavior as a generic contract.

Do not preserve golden expectations that require:

- `thread_key` as a mandatory generic manager-loop telemetry field
- `session_state` as a mandatory generic manager-loop telemetry field
- `executionId` as the stable public name for a backend-owned execution handle
- debug artifact placement that assumes only a run-root `system-prompt.md`

Add or update golden scenarios for:

- backend without `debugTelemetry` capability: CLI prints a warning and completes the run without debug artifacts
- backend without attached execution supervision capability: requesting attached backend execution supervision fails fast with a clear error
- backend with attached execution supervision capability: observe/steer works through generic contracts without pi-specific CLI types
- debug-agent node-level artifact layout: `system-prompt.md` appears in the node directory
- shared `thread_id` across multiple nodes: node-level prompt snapshots remain distinct per node

Golden tests should protect the abstraction boundary, not freeze the current pi-shaped implementation details.

### Runtime smoke checks

- `attractor run workflow.dot --debug-agent` still writes debug artifacts with the pi backend.
- `system-prompt.md` is written under the active node directory, not only at run root.
- shared-thread scenarios with multiple nodes produce distinct node-level prompt snapshots.
- `attractor serve` still exposes manager-loop observation when the backend supports it.
- A backend stub without debug support still runs successfully and only emits a warning.

## Risks

### Risk: Partial in-place rename leaves hidden leak paths behind

If the refactor updates the obvious types but misses exported APIs, persisted state, or golden fixtures, the legacy model will continue to influence future changes even without formal backward-compatibility support.

Mitigation:

- Treat exported surfaces, fixtures, and persistence as first-class migration targets.
- Remove old names aggressively once replacements exist.
- Add tests that specifically fail on legacy names and shapes.

### Risk: Over-generalizing too early

A generic contract that encodes pi-specific assumptions under neutral names would only hide the leak, not fix it.

Mitigation:

- Keep generic contracts minimal.
- Include only data required by core, CLI, server, and tests after this refactor.

### Risk: Manager observation remains backend-shaped

The observer path is currently tightly influenced by pi session runtime structure.

Mitigation:

- Standardize the observer capability boundary first.
- Keep telemetry payload unopinionated, but do not let CLI, server, or generic tests depend on backend-specific keys.

### Risk: The spec model and implementation model stay conflated

If the code keeps using one type name for both child pipelines and attached backend executions, future changes will continue to blur ownership and lifecycle boundaries.

Mitigation:

- Add explicit naming and comments early in the migration.
- Treat attached backend execution as an extension path, not as the default semantic meaning of child pipeline.

### Risk: Rename without semantic decoupling

If `executionId` is renamed to `backendExecutionRef` but still populated from thread-key resolution, the deepest abstraction leak will remain in place under a better name.

Mitigation:

- Treat the source of the value as part of the refactor, not just the field name.
- Add tests that fail if thread resolution continues to populate attached backend execution state implicitly.

## Recommended Sequencing Constraints

- Do not change debug artifact layout before the generic debug contract and node-level ownership model are in place.
- Do not update docs before the generic contracts and CLI wiring are stable.
- Do not keep dual-path compatibility longer than required to complete the in-place migration.
- Do not finish the refactor while the old `executionId` name still appears on any exported, persisted, or HTTP-visible surface where it means a backend-owned reference.
- Do not rely on a fresh implementer to infer the target child-execution model from legacy field names; keep the discriminated-union target explicit in the plan and in type-level comments during migration.
- Do not accept the migration as complete if `@attractor/core` still manufactures backend-owned execution references from thread/fidelity state.

## Amendment Rule

Implementation should stop and ask for an amended plan if any of the following happens:

- `@attractor/core` is not the right home for the shared contracts and a new shared package is needed.
- The HTTP server or manager-loop code depends on more backend-specific telemetry than currently visible.
- Another in-repo consumer requires the pi-specific types directly and cannot migrate in the same pass safely.
- The generic contract needs to model multiple incompatible backend shapes instead of one minimal shared seam.

If that happens:

1. Record the blocker and affected files.
2. Propose 2-3 contract options with tradeoffs.
3. Choose a new plan boundary before continuing.

## Maintainability Note

This refactor is worth doing only if the final ownership is obvious:

- `core` owns interfaces and capabilities
- `cli` owns UX and file materialization
- `backend-pi-dev` owns pi-specific adaptation

If a change does not clearly move code toward that ownership split, it is likely preserving the leak under a different name.
