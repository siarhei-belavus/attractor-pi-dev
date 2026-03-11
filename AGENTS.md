# Project Overview

This repository is an Attractor workflow runner and packaged CLI for multi-stage AI workflows defined as DOT graphs.

## High-Level Layout

- `packages/attractor-core`
  Generic engine, parser, runner, state, manager-loop, steering, and HTTP server logic.
- `packages/attractor-cli`
  Generic CLI layer.
  Should stay backend-agnostic and consume core contracts instead of backend-specific internals.
- `packages/backend-pi-dev`
  Pi-specific backend adapter and related runtime policy logic.
- `packages/attractor-pi`
  Shipped packaged CLI binary that wires the generic CLI to the pi backend.

## Docs Map

- `docs/user`
  User-facing docs and operator guidance.
- `docs/specs`
  behavior/spec reference and examples.
- `docs/plans`
  implementation plans and design notes.

## Stable Navigation Hints

- If behavior feels generic across backends, start in `packages/attractor-core`.
- If behavior is CLI-only but should not know backend internals, start in `packages/attractor-cli`.
- If behavior depends on provider/session/extensions/resource policy, start in `packages/backend-pi-dev`.
- If behavior reproduces only through the shipped `attractor` command, inspect `packages/attractor-pi`.

## Architecture Guidance

- For architectural refactors, optimize for the clean final design, not backward compatibility.
- Prefer in-place migration to the correct model over compatibility shims, dual paths, versioned names, or temporary adapters that preserve outdated contracts.
- Do not keep legacy fields, exports, or behavior alive just to avoid touching in-repo callers when the intended architecture is already clear.
- When a contract is being corrected, update the codebase to the new contract directly.
- Avoid “support both old and new” transitions; in this repo that creates drift and unnecessary mess.

## Engineering Principles

- Reuse the existing project pattern for a concern before introducing a new one.
  For logging, config, validation, dependency wiring, error handling, debug artifacts, and tests, extend the established approach instead of creating a parallel solution.
- Maximize type safety.
  Avoid `any`; prefer `unknown` plus narrowing, explicit unions, and small named types where boundaries are unclear.
- Fail fast.
  Do not hide errors, silently fall back, or add graceful-degradation branches unless the user explicitly asks for that behavior.
- Fix root causes instead of layering on bridge code.
  Avoid compatibility adapters, temporary wrappers, or “old and new” paths that keep incorrect architecture alive.
- Keep a single source of truth.
  Do not introduce duplicate state, duplicate flags, or multiple ways to answer the same question.
- Prefer explicitness over implicit magic.
  Make dependencies, configuration, state transitions, and important defaults visible in code instead of relying on hidden wiring or surprising behavior.
- Reuse before inventing.
  Study adjacent code first; if the repo already solves the same problem cleanly, copy that shape instead of adding a novel abstraction.
- Validate at boundaries.
  Parse and validate external inputs where they enter the system, then keep internals operating on validated data.
- Preserve error context.
  Throw or return precise errors with actionable detail; avoid broad catch-and-ignore handling, and avoid logging the same failure in multiple layers.
- Keep code small and focused.
  Prefer short, single-purpose functions and narrowly scoped modules over large mixed-responsibility files.
- Prefer explicit state over boolean piles.
  Use clear unions, enums, or state objects when behavior has more than one meaningful mode.
- Treat warnings as work to fix.
  Do not normalize deprecations, type warnings, or “temporary” noisy output.
- Measure before optimizing.
  Do not add complexity for performance without evidence that the path is actually hot.
- Give resources explicit ownership.
  Long-lived handles, sessions, streams, and temp artifacts should have a clear lifecycle and cleanup responsibility.
- Prefer dependency injection and separation of concerns.
  Pass collaborators in at the right seam instead of constructing deep dependencies inside business logic.
- Prefer real-path verification for risky wiring.
  For CLI, backend, and packaging changes, favor high-signal integration or smoke coverage over mock-heavy tests when the real path is practical.
- Do not guess about hidden contracts.
  Inspect local patterns, docs, and tests first; if a choice would create a second architectural path, stop and confirm rather than improvising.

## Change Strategy

- For substantial refactors, describe the target end state, moved responsibilities, and validation approach before making broad edits.
- Rename once and remove old names in the same change series when the repo is ready to move.
- If the existing project-wide pattern is wrong, prefer a coordinated refactor toward one better pattern rather than introducing a second way to do the job.

# Test Levels

Use the smallest test layer that proves the behavior.

## Layer Map

- `packages/attractor-core/tests/*.test.ts`
  Core unit + integration tests for parser, engine, runner, state, manager-loop, steering, server behavior, and generic contracts.
- `packages/backend-pi-dev/tests/*.test.ts`
  Pi-backend adapter tests for session/runtime mapping, provider policy, extension policy, backend defaults, and backend-specific integrations.
- `packages/attractor-cli/tests/*.test.ts`
  Generic CLI tests for argument handling, debug writer behavior, and package-local command wiring.
- `packages/attractor-cli/tests/golden/**`
  Golden CLI regression coverage.
  Use for stable CLI output, checkpoints, and simulate-mode scenarios.
- `packages/attractor-pi/tests/smoke.test.ts`
  Packaged CLI smoke coverage for `dist/attractor.mjs`.
  Use for one expensive real-LLM run that proves the shipped binary path, real backend wiring, and high-signal artifact invariants.

## Where To Add Tests

- Core graph/runner/HTTP/manager behavior:
  add tests under `packages/attractor-core/tests/`.
- Pi adapter logic, extension/resource policy, provider defaults, session behavior:
  add tests under `packages/backend-pi-dev/tests/`.
- Generic CLI behavior that does not require the packaged binary:
  add tests under `packages/attractor-cli/tests/`.
- Simulate-mode CLI regressions and output snapshots:
  prefer `packages/attractor-cli/tests/golden/**`.
- Packaged binary regressions that must exercise `node packages/attractor-pi/dist/attractor.mjs ...`:
  add or extend `packages/attractor-pi/tests/smoke.test.ts`.

## Smoke Rules

- Keep `packages/attractor-pi/tests/smoke.test.ts` to a single real-LLM run when possible.
- Reuse one expensive run for multiple assertions instead of adding more real-LLM scenarios.
- Do not add `--simulate` packaged smoke coverage there; simulate-path regressions belong in CLI golden tests.
- Assert only high-signal invariants:
  process success, key artifacts, packaged CLI wiring, debug layout, checkpoint/manifest sanity.

## Validation Order

1. Run the narrow package-local test first.
2. Run golden tests when CLI snapshots/output contracts change.
3. Run packaged smoke only when binary-path or real-backend behavior changes.
