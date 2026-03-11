# Steering Queue Abstraction Plan

## Objective

Replace direct manager-to-backend steering with a backend-agnostic, queue-first control path that keeps `@attractor/core` unaware of backend capabilities.

Target behavior:

- `stack.manager_loop` always publishes steering as queue messages.
- The queue is process-local and in-memory by design for the first implementation.
- Backends consume steering according to their runtime model:
  - stateful backends may deliver immediately to a live session;
  - stateless backends may consume before the next model call;
  - future child-graph runtimes may consume before the next child stage.
- CLI and HTTP steering enqueue messages instead of requiring a live pi binding.
- The first implementation does not promise delivery across process restart or checkpoint resume.

## Scope

In scope:

- queue contract and target model in `@attractor/core`
- manager-loop producer path
- HTTP/CLI enqueue path
- pi backend consumer path
- tests for parallel, fan-in, and process-local semantics
- documentation updates for the new contract
- full removal of the old direct steering path with no backward-compatibility layer

Out of scope for this pass:

- durable persistence of steering across restart or resume
- a universal stateless backend consumer implementation
- retrofitting checkpoint/recovery to replay pending steering
- redesigning manager loop into full child-graph autostart supervision

## Current Change Surface

Core modules affected:

- `packages/attractor-core/src/handlers/handlers.ts`
- `packages/attractor-core/src/handlers/types.ts`
- `packages/attractor-core/src/engine/runner.ts`
- `packages/attractor-core/src/server/index.ts`
- `packages/attractor-core/src/state/context.ts`
- `packages/attractor-cli/src/index.ts`

Backend-specific modules affected:

- `packages/backend-pi-dev/src/backend.ts`
- any session lookup / session steering helpers used by the pi backend

Test surfaces affected:

- `packages/attractor-core/tests/manager-loop.test.ts`
- `packages/attractor-core/tests/integration.test.ts`
- `packages/attractor-core/tests/server.test.ts`
- `packages/attractor-core/tests/parallel-subgraph.test.ts`
- `packages/attractor-core/tests/state.test.ts`
- `packages/backend-pi-dev/tests/manager-observer.test.ts`

## Repository Risk Analysis

### 1. Source-of-truth risk

Current steering is split between:

- `ManagerLoopHandler` calling `observer.steer(...)`
- HTTP server calling `managerSteerer.steer(...)`
- pi backend mapping both paths onto a live session binding key

If queueing is added without removing or clearly subordinating the direct path, the codebase will gain two sources of truth for steering delivery.

Planning rule:

- the queue must become the only producer interface;
- the old direct manager/API-to-backend steering path must be removed, not preserved behind fallback behavior.

### 2. Target identity risk

Current manager wiring depends on `internal.last_completed_thread_key`, which is pi-specific. If the new queue keeps `bindingKey` as the only target identity, `@attractor/core` will stay backend-coupled.

Planning rule:

- core must target an abstract execution identity;
- backend-specific identifiers such as `bindingKey` may exist only as optional backend metadata.

### 3. Parallel branch leakage risk

`ParallelHandler` clones `Context` per branch. If steering queue state is stored naïvely inside branch-cloned context or copied by reference, messages can:

- leak into sibling branches;
- be duplicated across branches;
- be consumed more than once.

Planning rule:

- steering scope must be explicit and branch-safe;
- branch-local messages must not be visible to sibling branches by default.

### 4. Fan-in contamination risk

`fan-in` reads `parallel.results` only. If branch-scoped steering survives past branch completion or is implicitly merged, post-merge stages may see stale guidance meant for a single branch.

Planning rule:

- branch-scoped steering must not auto-propagate through `fan_in`;
- post-merge steering must be newly targeted to the merged execution scope.

### 5. Restart and resume truthfulness risk

Current run recovery already persists `run-state.json` and `checkpoint.json`, but `activeManagerBindingKey` is in-memory only. That is acceptable today because the steering contract is effectively live-session-only.

If we introduce a queue but leave restart semantics implicit, users may assume queued steering survives restart when it does not.

Planning rule:

- first implementation must explicitly document steering as ephemeral and process-local;
- API responses and docs must not imply durability.

### 6. API behavior change risk

Today `POST /pipelines/{id}/steer` can return `409` when no active manager-bound child session exists. Under a queue-first model, enqueue may succeed even when no live consumer exists yet.

Planning rule:

- API semantics must be intentionally redefined, not drift accidentally;
- tests and CLI output must be updated in the same phase as the contract change.

### 7. Shallow clone and mutable payload risk

`Context.clone()` currently copies values shallowly. If queue payloads or target registries are stored as mutable objects in normal context values, branch isolation and synthetic-context evaluation may behave unpredictably.

Planning rule:

- steering queue state should not piggyback on arbitrary mutable context values;
- queue ownership should live in one obvious owner module with explicit copy semantics.

### 8. Workspace drift risk

The current worktree already contains uncommitted changes in manager-loop-related files. A large mixed refactor would be easy to mis-review and easy to conflict with.

Planning rule:

- keep the plan phased and reviewable;
- isolate queue contract work from pi backend consumer work from API/docs work.

## Success Criteria

The change is done when all of the following are true:

- `ManagerLoopHandler` no longer needs to know whether the backend is stateful or stateless.
- HTTP/CLI steering uses the same enqueue path as manager-generated steering.
- The first pi consumer can apply queued messages to active sessions without changing core semantics.
- Branch-scoped steering does not leak across `parallel` branches or through `fan_in`.
- Restart/resume behavior is explicit and documented as non-durable for the first pass.
- The changed contract is covered by focused tests, not only happy-path integration tests.

## Recommended Design

### Canonical model

- producer: manager loop, CLI, HTTP API
- transport: in-memory steering queue
- consumer: backend/runtime-specific adapter
- application point:
  - live session for stateful backends;
  - next step for stateless backends

### First-pass semantic contract

- steering is best-effort
- steering is process-local
- steering may be lost on process exit, restart, or resume
- steering is consumed once
- absence of a current consumer does not prevent enqueue

### Core abstractions

Introduce narrow queue-oriented interfaces in `@attractor/core`, for example:

```ts
interface SteeringTarget {
  runId: string;
  executionId: string;
  branchKey?: string;
  nodeId?: string;
}

interface SteeringMessage {
  id: string;
  target: SteeringTarget;
  message: string;
  source: "manager" | "cli" | "api" | "system";
  createdAt: string;
}

interface SteeringQueue {
  enqueue(message: SteeringMessage): void;
  drain(target: SteeringTarget): SteeringMessage[];
  peek(target: SteeringTarget): SteeringMessage[];
}
```

Notes:

- the exact names may differ;
- the important part is that core targets an execution scope, not a pi thread contract.

## Implementation Plan

### Phase 1: Freeze semantics and choose the target model

Purpose:

- define one explicit contract before code changes begin

Tasks:

- choose the first-pass `SteeringTarget` shape
- define whether the initial target is run-scoped, execution-scoped, or branch-scoped by default
- define the accepted first-pass semantics for process restart and resume
- document that the queue is ephemeral and not part of checkpoint state
- explicitly declare removal of the legacy direct-steer contract and all compatibility shims

Why first:

- this prevents the implementation from baking pi-specific identifiers into core again

### Phase 2: Add queue ownership in core without behavior changes

Purpose:

- create one obvious owner for queue state and lifecycle before rerouting producers

Tasks:

- add queue types and owner module in `@attractor/core`
- keep queue state outside ad hoc mutable context values
- add unit tests for enqueue, drain, empty reads, and target filtering
- add tests proving queue state is intentionally excluded from checkpoint snapshots

Why second:

- queue state must be trustworthy before manager loop, CLI, or backend consumers start using it

### Phase 3: Convert manager loop into a pure producer

Purpose:

- make manager-loop semantics backend-agnostic

Tasks:

- replace direct manager steering calls with queue enqueue operations
- keep `observe()` unchanged for this phase
- preserve manager-loop cycle accounting and artifacts
- add tests showing manager loop emits steering messages without requiring a live backend delivery path

Why third:

- this removes backend capability assumptions from the core supervision logic

### Phase 4: Convert HTTP and CLI steering to the same enqueue path

Purpose:

- unify user-triggered and manager-triggered steering under one control plane

Tasks:

- change `POST /pipelines/{id}/steer` to enqueue instead of requiring live `activeManagerBindingKey`
- update CLI `steer` command to report enqueue success rather than live delivery success
- remove `409` behavior that depends on active live binding only
- update server tests and CLI docs in the same step

Why fourth:

- queue semantics are incomplete if external steering still bypasses the queue

### Phase 5: Add a pi backend consumer adapter

Purpose:

- preserve current live-session usability for the pi backend without leaking that model into core

Tasks:

- implement a pi-specific consumer that polls or drains queued messages for active execution targets
- map queued messages onto live `session.steer(...)` only inside `@attractor/backend-pi-dev`
- define when a message counts as consumed in the pi path
- add tests covering active-session consumption and empty-queue behavior
- remove `managerSteerer`-style direct delivery entrypoints that bypass the queue

Why fifth:

- this keeps the current useful behavior for pi while making it a backend detail

### Phase 6: Define branch and fan-in scope rules explicitly

Purpose:

- prevent hard-to-debug leakage in `parallel` graphs

Tasks:

- decide the branch identity source for parallel executions
- ensure a branch consumer sees only its own messages by default
- ensure branch-scoped steering does not auto-propagate through `fan_in`
- add targeted tests for:
  - one branch receives steering and siblings do not;
  - post-fan-in node does not inherit stale branch messages;
  - run-wide steering, if allowed, behaves as deliberate broadcast

Why sixth:

- this is the highest-risk lifecycle edge after core/backend decoupling

### Phase 7: Add extension hooks for stateless backends

Purpose:

- make the abstraction genuinely backend-agnostic even if only pi is implemented first

Tasks:

- define where a stateless backend would drain queued messages before the next model call
- add a core helper or adapter contract for “consume before next step”
- document this hook without forcing a full implementation for every backend immediately

Why seventh:

- the abstraction should not silently assume stateful runtimes

### Phase 8: Update docs, matrixes, and operational guidance

Purpose:

- keep public and internal docs truthful

Tasks:

- update README manager-loop description
- update CLI and HTTP docs for enqueue semantics
- update language/spec guidance where it currently implies child-pipeline steering instead of queue-based execution guidance
- refresh traceability notes so they stop describing already-changed behavior

Why last:

- docs should reflect the settled contract, not intermediate implementation details

## Validation Plan

Focused tests to add or update:

- unit tests for queue owner module
- state tests proving queue exclusion from checkpoint snapshots
- manager-loop tests for producer-only steering path
- server tests for enqueue semantics without active live binding
- CLI tests or smoke paths for user-facing `steer` output
- pi backend tests for active-session consumption
- parallel/fan-in tests for target isolation and no leakage

Broader validation:

- `pnpm --filter @attractor/core test -- manager-loop integration server parallel-subgraph state`
- `pnpm --filter @attractor/backend-pi-dev test -- manager-observer`

Manual smoke checks:

- enqueue steering while manager is running and verify consumption
- enqueue steering before consumer becomes active and verify later pickup within the same process
- confirm restart drops pending steering and that docs reflect this

## Sequencing Constraints

- Do not combine queue ownership and pi consumer implementation in one step.
- Do not change HTTP/CLI semantics before the queue owner exists.
- Do not add branch-scoped behavior after shipping run-scoped semantics without explicit tests, because that will make later review ambiguous.
- Do not store queue payloads inside ordinary context values unless clone and checkpoint semantics are explicitly handled.
- Do not leave the legacy direct steering path in place after the queue path lands; delete it in the migration, not in a later cleanup pass.

## Amendment Triggers

Implementation must stop and ask for a plan amendment if any of the following becomes true:

- the only viable target identity is pi-specific and cannot be abstracted cleanly
- queue ownership cannot be isolated without breaking existing context or checkpoint assumptions
- branch identity in `parallel` is not stable enough to support safe target filtering
- server/API behavior must remain backward-compatible with live-delivery `409` semantics
- the current uncommitted workspace changes conflict with the planned queue ownership or manager-loop edit points

Use a `REVIEW_NOTE` instead of an amendment only for:

- non-blocking alternative names or API shapes
- follow-up improvements such as durable persistence or richer delivery diagnostics
- extra backend integrations that do not alter the sequencing above

## Maintainability Note

The safest long-term design is to centralize steering message lifecycle in one owner module and make backend code own only the application step. That keeps future review simple:

- core answers “who can publish and how messages are scoped”
- backend answers “when and how messages are consumed”

That split reduces navigation cost and avoids reintroducing pi-specific assumptions into orchestration code.
