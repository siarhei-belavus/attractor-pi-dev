# Agent Streaming + Dashboard Plan

## Objective

- Provide live pipeline observability for CLI and future UI dashboard:
  - current node,
  - streamed LLM output,
  - tool activity.
- Keep server streaming enabled by default.
- Keep CLI streaming opt-in via `--stream-agent`.

## Scope

### In scope

1. Runtime LLM/tool events in server SSE (`/events/:runId`) enabled by default.
2. `--stream-agent` support in CLI (`attractor run`) as opt-in display mode.
3. Stable event correlation fields for UI rendering across stages/threads.
4. Backward-compatible additive event model for existing clients.

### Out of scope

1. Full dashboard frontend implementation.
2. New transport protocol beyond SSE.
3. Extension loading/tool wiring refactor.
4. Debug artifact capture (`--debug-agent`) and system prompt diagnostics.

## Phased Implementation

### Phase 1: Event Contract Foundation

1. Add additive runtime event types:
   - `llm_text_start`
   - `llm_text_delta`
   - `llm_text_end`
   - `tool_call_start`
   - `tool_call_end`
   - `session_error`
2. Include correlation envelope fields:
   - `runId`
   - `stage`
   - `threadKey`
   - `timestamp`
   - `sequence`
3. Keep existing pipeline events unchanged for compatibility.

### Phase 2: CLI Streaming (`--stream-agent`)

1. Add `--stream-agent` flag to `attractor run`.
2. On enabled flag, print live:
   - assistant text deltas,
   - tool call start/end.
3. Keep default CLI output unchanged when flag is absent.
4. Update CLI help and docs.

### Phase 3: Server SSE Runtime Streaming

1. Extend run event publishing to include runtime events (in addition to current pipeline events).
2. Continue serving all events via existing `GET /events/:runId` SSE endpoint.
3. Enable runtime stream by default in server mode.
4. Preserve backward compatibility for existing clients (additive-only event model).
5. Ensure parallel branch interleaving remains UI-correlatable via `stage/threadKey`.

### Phase 4: Validation and Hardening

1. Unit tests:
   - event mapping/serialization.
2. Integration tests:
   - `attractor run --stream-agent`,
   - `serve + /events/:runId` live runtime stream,
   - retry/wait/cancel/resume lifecycle paths.
3. Smoke run with real model/provider path.

## Key Risks

1. Event correlation issues across parallel branches and session reuse.
2. Noisy CLI UX due to verbose stream output.
3. SSE payload growth under long-running pipelines.

## Mitigations

1. Strong event correlation envelope with deterministic sequencing.
2. `--stream-agent` opt-in behavior only.
3. Size guards/rotation policy for in-memory event buffers.

## Definition of Done

1. CLI with `--stream-agent` shows live LLM and tool activity.
2. SSE provides pipeline + runtime events for UI consumption.
3. Server mode streams runtime events by default.
4. Current node is continuously available via status/events.
5. Tests and smoke checks pass.

## Amendment Rule

Stop implementation and request plan amendment if any of the following occurs:

1. Reliable event correlation cannot be guaranteed for parallel/retry/reuse paths.
2. A breaking API change to existing CLI/SSE contracts becomes unavoidable.
3. Runtime stream materially degrades server stability.

When blocked, present 2-3 options with trade-offs and wait for explicit human decision.
