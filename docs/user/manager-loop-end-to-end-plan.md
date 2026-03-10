# Manager Loop End-to-End Plan

Related issue: `df-aar.3` — `Wire manager loop observer end-to-end`

## Objective

Bring `stack.manager_loop` to real end-to-end behavior:

- `PipelineRunner` must be able to wire a real observer into `ManagerLoopHandler`
- backend/runtime must provide a working `observe/steer` implementation
- `stack.manager_loop` must fail fast when observer wiring is missing instead of silently degrading to a no-op
- users must be able to inject steering messages into a running pipeline through both Web API and CLI

Relevant code:

- `packages/attractor-core/src/handlers/handlers.ts`
- `packages/attractor-core/src/handlers/registry.ts`
- `packages/attractor-core/src/engine/runner.ts`
- `packages/backend-pi-dev/src/backend.ts`
- `packages/backend-pi-dev/src/session.ts`

## Assumptions

- The safest design is to keep loop semantics inside `ManagerLoopHandler` and move only dependency wiring into the runner/runtime.
- `@attractor/core` should stay backend-agnostic.
- The concrete observer for pi-based execution should live in `packages/backend-pi-dev`.
- There should be one source of truth for child-session state; the observer should inspect and steer the same reused child session/thread that the backend already owns.

## PI Backend Research Summary

Research sources:

- local adapter code in:
  - `packages/backend-pi-dev/src/backend.ts`
  - `packages/backend-pi-dev/src/session.ts`
- upstream GitHub project:
  - `https://github.com/badlogic/pi-mono`
  - `packages/coding-agent` documentation
  - `packages/agent` event model

Findings:

- The upstream pi stack already supports steering during execution.
- The upstream agent/session stack already exposes a useful event stream:
  - agent start/end
  - turn start/end
  - message start/update/end
  - tool execution start/update/end
- Sessions are persisted in pi-coding-agent and already maintain conversation/tool history.
- Our local `Session` wrapper already exposes several useful read paths:
  - `state`
  - `getLastAssistantText()`
  - `getMessages()`
  - `getActiveToolNames()`
  - `getToolPolicyDiagnostics()`
  - `steer(message)`

Conclusion:

- The main missing pieces for observer support are in our adapter boundary, not in pi itself.
- We do not need a deep redesign of pi integration to support observer mechanics.
- We do need a narrow backend-facing observer API and a stable way to look up a child session by binding key.

## Observe Payload Contract

The observer should return a normalized snapshot built from the pi-backed child session.

Minimum contract:

```ts
{
  childStatus: "running" | "completed" | "failed",
  childOutcome?: "success" | "fail",
  telemetry: {
    session_state: "IDLE" | "PROCESSING" | "AWAITING_INPUT" | "CLOSED",
    awaiting_input: boolean,
    last_assistant_text: string,
    message_count: number,
    active_tools: string[],
    tool_policy_diagnostics: string[],
    thread_key: string,
    provider: string,
    model_id: string
  }
}
```

Expected mapping rules for the first implementation:

- `PROCESSING` -> `childStatus = "running"`
- `AWAITING_INPUT` -> `childStatus = "running"` with `telemetry.awaiting_input = true`
- `IDLE` -> terminal state only if we have explicit evidence the child completed successfully
- `CLOSED` -> terminal state only if we can distinguish success from failure, otherwise this state needs an explicit adapter-level outcome signal

Important note:

- `Session.state` alone is not enough to derive a trustworthy `childOutcome`.
- The backend must expose an explicit terminal result or a small read-only snapshot API so the observer can tell success from failure without heuristics.

## Backend Gaps Identified By Research

The following pieces are not yet implemented and are required for a robust observer:

- session lookup by binding key such as `threadKey`
- explicit terminal outcome for a child session
- explicit terminal failure reason or failure classification
- optional progress counters such as turn count / tool round count
- optional last-activity timestamp for richer supervision logic

Recommended approach:

- add a narrow read-only snapshot method in `PiAgentCodergenBackend` or `Session`
- do not expose the whole mutable `Session` object unless it becomes unavoidable
- keep observer reads and steering on the same session registry already used for session reuse

## Success Criteria

The work is done when all of the following are true:

- `PipelineRunner` has an explicit mechanism to wire a `ManagerObserver` into `ManagerLoopHandler`
- a pipeline containing a `shape=house` node executes a real observe/steer cycle in integration tests
- the pi backend exposes enough runtime state to implement a real observer
- steering reaches the child session via existing session APIs
- a manager-loop node without observer wiring no longer succeeds silently
- Web API exposes a steering endpoint for running pipelines
- CLI exposes a command or subcommand for sending a steering message to a running pipeline
- `README.md` no longer describes manager loops as effectively no-op

## Implementation Plan

1. Define the observer wiring contract in core

- Extend `RunConfig` with an explicit way to provide a `ManagerObserver` or `ManagerObserverFactory`
- Prefer a factory over a singleton observer so the runtime can create stateful observers tied to node/context/thread information
- Keep the contract narrow and focused on the existing `ManagerObserver` interface

Why first:

- This is the lowest-risk foundation and keeps the dependency boundary explicit before backend work starts

2. Wire `ManagerLoopHandler` in `PipelineRunner`

- Add a wiring path similar to `wireParallelHandler()`
- Use the existing `getManagerLoopHandler()` accessor in `HandlerRegistry`
- Keep runner ownership limited to supplying the observer dependency, not running manager logic itself

Why second:

- This proves the core runtime can support manager-loop wiring without introducing backend coupling yet

3. Add core integration coverage with a fake observer

- Add a `PipelineRunner` integration test using a real graph with a `house` node
- Verify success path through observe/steer
- Verify failure path when child reports failed
- Verify that missing observer wiring is treated as configuration/runtime failure

Why third:

- This validates the lifecycle behavior in `@attractor/core` before adding backend complexity

4. Design the backend-specific child binding strategy

- Decide how the observer identifies the child session:
  - reuse `thread_id`
  - reuse `internal.thread_key`
  - or introduce a dedicated manager/child binding attribute if the existing keys are not reliable enough
- Document the decision before coding the observer

Why fourth:

- This is the riskiest design edge; it controls correctness for reuse, restart, and future maintenance

5. Expose minimal backend hooks needed for observation

- Add only the smallest set of accessors needed in `PiAgentCodergenBackend` and/or `Session`
- Typical needs:
  - lookup child session by thread key
  - read a normalized session snapshot for observer use
  - read session state
  - read latest assistant output / telemetry
  - read explicit terminal outcome / failure reason
  - steer the existing session
- Avoid passing full mutable session objects across package boundaries if a narrower API is enough

Why fifth:

- This reduces coupling and keeps the backend reviewable

6. Implement `PiManagerObserver`

- Add a concrete observer in `packages/backend-pi-dev`
- `observe()` should translate child session state into:
  - `running`
  - `completed`
  - `failed`
- `observe()` should also attach useful telemetry for context
- `steer()` should inject guidance through the existing `Session.steer()` path

Why sixth:

- By this point the core contract and backend access points are stable, so the observer becomes a straightforward adapter

7. Connect backend observer creation to runtime construction

- Pass the observer factory into the runner where the pipeline is actually executed
- Ensure the same session reuse mechanism used by codergen nodes is also used by the observer
- Avoid introducing a second parallel session registry or hidden cache

Why seventh:

- This is the final integration seam and should be done only after both sides are independently verified

8. Add external steering APIs

- Add a Web API endpoint for steering a running pipeline, for example:
  - `POST /pipelines/{id}/steer`
- Define request/response semantics clearly:
  - request body contains at least `message`
  - `404` for unknown run
  - `409` when the run has no active manager-loop-bound child session
  - success response confirms delivery or queueing
- Add a CLI entry point that sends a steering message to a running pipeline served by `attractor serve`
- Keep the CLI thin: it should call the server API rather than reimplement runtime lookup rules

Why eighth:

- Once manager-loop wiring works internally, the next safe step is to expose a minimal external control surface without duplicating orchestration logic

9. Update docs and examples

- Remove the manager-loop gap note from `README.md`
- Add a short note describing:
  - when manager loop works
  - what binds it to the child session
  - any current limitations
- Document how to send a steering message through both:
  - the Web API
  - the CLI

Why last:

- Documentation should reflect the final implemented behavior, not the intended design

## Key Risks

### Session ownership mismatch

If the observer and codergen backend resolve different child sessions for the same manager loop, behavior will become nondeterministic.

### Hidden in-memory coupling

If the observer only works while the exact process stays alive, manager loops may not remain truthful under restart or resume.

### Too much backend surface area

If the implementation exposes entire session internals instead of narrow observer-oriented APIs, long-term maintainability will drop.

## Validation Plan

### Core validation

- Keep `packages/attractor-core/tests/manager-loop.test.ts` as unit coverage for handler semantics
- Add `PipelineRunner`-level integration coverage for a real manager-loop graph
- Verify both:
  - observer-wired success/failure behavior
  - hard failure when observer wiring is absent

### Backend validation

- Add focused tests in `packages/backend-pi-dev` for observer/session binding
- Verify that `steer()` actually reaches the reused child session
- Verify state mapping from session lifecycle to `ManagerObserver.observe()`

### API validation

- Add server tests for the steering endpoint:
  - running manager loop accepts message
  - unknown run returns `404`
  - run without active steerable session returns `409`
- Add CLI tests for steering command argument parsing and request dispatch

### Command-level validation

- Run `pnpm --filter @attractor/core test`
- Run the relevant `@attractor/backend-pi-dev` tests added for the observer integration
- Run the relevant `@attractor-cli` tests added for steering

## Sequencing Constraints

- Do not start backend observer implementation before the core wiring contract is explicit and tested
- Do not broaden the public API until the child binding strategy is chosen
- Do not update documentation until integration tests pass

## Amendment Rule

If implementation reveals that the current `thread_id` / `internal.thread_key` model cannot safely identify the child session across restart or resume, stop and amend the plan before continuing.

The amendment should choose one of these paths explicitly:

1. Add an explicit child-binding attribute such as `child_thread_id` or `child_session_key`
2. Implement a documented limitation and defer full restart-safe parity

No silent improvisation should happen at that boundary because it affects lifecycle correctness and future reviewability.
