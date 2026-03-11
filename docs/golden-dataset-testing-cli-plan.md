# Golden Dataset Testing Plan for `attractor-pi-dev`

## Objective

Adopt the `Golden Dataset Testing` approach used in `factorial`, but adapt it to `attractor-pi-dev` as a CLI-first regression layer.

The goal is not to add more unit tests around `PipelineRunner`. The goal is to verify stable end-to-end behavior through the real CLI entrypoint, with deterministic fixtures and reviewable expected outputs.

## Source Pattern We Are Adapting

In `factorial` (/Users/Siarhei_Belavus/Projects/explore/factorial), the pattern is:

- a dedicated golden suite with `workflows/`, `seed/`, and `expected/`
- one orchestrating test that runs every workflow
- deterministic capture of normalized output
- checked-in expected JSON artifacts
- controlled update flow via `UPDATE_GOLDEN=1`
- a separate `test:golden` command so the suite stays explicit

The closest matching files there are:

- `tests/golden/golden-regression.test.ts`
- `tests/golden/workflows/*.dot`
- `tests/golden/seed/*.json`
- `tests/golden/expected/*.json`
- `packages/cli/src/test-harness.ts`

## Recommended Placement in This Repository

Because we want to call the real CLI, this suite should live with `@attractor/cli`, not `@attractor/core`.

Recommended layout:

```text
packages/attractor-cli/
  tests/
    golden/
      golden-regression.test.ts
      workflows/
      seed/
      expected/
    helpers/
      cli-golden-harness.ts
```

Reasoning:

- `@attractor/core` should keep unit and integration coverage for engine internals.
- `@attractor/cli` should own user-facing execution-path regressions.
- this keeps CLI harness code out of core and makes ownership obvious.

## Success Criteria

The migration is done when all of the following are true:

- `@attractor/cli` has a dedicated `test:golden` command
- the golden suite runs the built CLI entrypoint directly
- each golden scenario is defined as a checked-in `.dot` workflow
- optional seed data can be applied deterministically per workflow
- test output is normalized into stable JSON snapshots
- expected outputs are checked into git
- updating expected outputs requires an explicit golden-update flow

## Scope

### In scope

- golden regression coverage through CLI
- deterministic fixture layout
- normalized expected JSON snapshots
- helper harness for build, temp isolation, and output normalization
- a small initial scenario set

### Out of scope

- replacing existing `@attractor/core` integration tests
- snapshotting all raw logs or every generated file byte-for-byte
- broad CLI refactors unrelated to golden testing
- adding runtime features unless the harness cannot work without them

## Recommended Implementation Plan

### 1. Create a CLI golden harness

Add a reusable helper, for example:

- `packages/attractor-cli/tests/helpers/cli-golden-harness.ts`

This helper should own:

- ensuring the CLI package is built before tests run
- creating isolated temp directories per scenario
- invoking the CLI entrypoint with deterministic arguments
- capturing `exitCode`, `stdout`, `stderr`, and output directories
- loading artifacts and converting them into a normalized snapshot

Keep this helper test-oriented. Do not add CLI runtime flags unless the harness cannot function without them.

### 2. Add dedicated golden fixture directories

Create:

- `packages/attractor-cli/tests/golden/workflows/`
- `packages/attractor-cli/tests/golden/seed/`
- `packages/attractor-cli/tests/golden/expected/`

Each workflow should be the source of truth for one end-to-end regression scenario.

Recommended convention:

- `workflows/<name>.dot`
- `seed/<name>.json`
- `expected/<name>.json`

Seed files should be optional. If `seed/<name>.json` does not exist, the scenario runs with default context.

### 3. Implement one orchestrating golden test

Add:

- `packages/attractor-cli/tests/golden/golden-regression.test.ts`

This test should:

- enumerate all `.dot` files in `workflows/`
- locate the matching seed and expected files
- run each scenario through the real CLI
- build a normalized JSON snapshot
- compare against checked-in expected output
- overwrite expected output only when `UPDATE_GOLDEN=1`

This keeps the suite easy to review and keeps the update path explicit.

### 4. Normalize output aggressively

This is the most important adaptation for our repo.

We should not compare the raw run directory. The harness should produce a stable summary that excludes noisy fields such as:

- timestamps
- absolute temp paths
- machine-specific values
- unordered maps when order is not semantically meaningful
- verbose stdout sections that are not part of the contract

Recommended first snapshot shape:

```json
{
  "scenario": "human-gate-approve",
  "cli": {
    "exit_code": 0
  },
  "run": {
    "outcome": {
      "status": "success",
      "failureReason": ""
    },
    "completedNodes": ["start", "review", "ship_it", "exit"]
  },
  "artifacts": {
    "checkpoint": {
      "...normalized fields...": true
    },
    "node_status": {
      "review": {
        "...normalized fields...": true
      }
    }
  }
}
```

For the first pass, prefer a small schema over a complete dump.

### 5. Start with a small MVP scenario set

Do not migrate every interesting path immediately.

Recommended first batch:

- `simple-linear-success`
- `conditional-branch-success`
- `human-gate-auto-approve`
- `parallel-fanout-basic` or one manager-loop scenario

These already map well to existing behavior covered in `@attractor/core` tests and should give good confidence without making the suite fragile on day one.

### 6. Add explicit package scripts

In `packages/attractor-cli/package.json`, add:

- `test:golden`

Recommended shape:

- build first if the suite executes `dist/index.js`
- run only the golden test file or folder

At the repo root, optionally add:

- `test:golden`

that delegates to `pnpm --filter @attractor/cli test:golden`.

### 7. Document the golden update workflow

Add a short note either to:

- `docs/golden-dataset-testing-cli-plan.md` later expanded into usage notes
- or a package-level README section if one is introduced

The workflow should be:

1. run `test:golden`
2. inspect the diff if expected output changed semantically
3. rerun with `UPDATE_GOLDEN=1` only when the new behavior is intentional
4. rerun `test:golden` without the flag to prove the suite is stable

## Recommended File Ownership

- `packages/attractor-cli/tests/golden/*`
  CLI golden scenarios and expected artifacts
- `packages/attractor-cli/tests/helpers/cli-golden-harness.ts`
  deterministic build/run/normalize helper
- `packages/attractor-cli/package.json`
  package-level golden script
- root `package.json`
  optional convenience script only

## Validation Plan

Minimum validation for implementation:

1. `pnpm --filter @attractor/cli test`
2. `pnpm --filter @attractor/cli test:golden`
3. `UPDATE_GOLDEN=1 pnpm --filter @attractor/cli test:golden`
4. `pnpm --filter @attractor/cli test:golden`

Expected outcome:

- normal run passes against checked-in expected outputs
- update mode rewrites only expected JSON files
- rerun after update passes cleanly

## Implemented Golden Workflow

The CLI golden suite now lives under:

- `packages/attractor-cli/tests/golden/`
- `packages/attractor-cli/tests/helpers/cli-golden-harness.ts`

Usage:

1. run `pnpm --filter @attractor/cli test:golden`
2. inspect diffs in `packages/attractor-cli/tests/golden/expected/*.json`
3. rerun with `UPDATE_GOLDEN=1 pnpm --filter @attractor/cli test:golden` when the new behavior is intentional
4. rerun `pnpm --filter @attractor/cli test:golden` without the flag to confirm stability

## Key Risks

### Over-snapshotting

If we capture too much of the run directory, the suite will be noisy and expensive to maintain.

Mitigation:

- normalize to a narrow contract
- add fields only when they protect against a real regression

### CLI noise and environment sensitivity

CLI tests can vary because of paths, build outputs, and process boundaries.

Mitigation:

- isolate temp directories
- normalize paths
- avoid asserting on unstable stdout text unless it is part of the CLI contract

### Duplicating coverage without adding value

If the suite just mirrors current integration tests one-for-one, it adds runtime cost without improving confidence.

Mitigation:

- choose only scenarios where end-to-end CLI execution matters
- keep lower-level semantics covered in core tests

### Adding runtime features too early

It may be tempting to add CLI flags or runtime hooks immediately for test convenience.

Mitigation:

- prefer test harness logic first
- add product-surface changes only when the harness is truly blocked

## Recommended Rollout Order

### Phase 1

- create harness
- add package script
- implement 2 simple golden scenarios

### Phase 2

- add human gate scenario
- add one branch or parallel scenario
- stabilize normalization schema

### Phase 3

- add richer scenarios only if they cover real CLI regressions
- optionally add root-level convenience script
- document maintenance workflow

## Amendment Rule During Implementation

Implementation should stop and be amended if any of the following happens:

- the CLI cannot be exercised deterministically without changing product behavior
- artifact structure is too unstable to normalize safely
- scenario setup requires test-only hooks inside core or backend packages that would widen public surface area unnecessarily

If that happens, the next step should be to choose one of these explicitly:

1. keep CLI-first and add a minimal explicit test hook
2. keep CLI-first but reduce the initial scenario scope
3. split the design into CLI golden tests plus a smaller runner-level helper for setup only

## Recommendation

Use CLI-first golden testing as a thin, explicit regression layer for a small number of high-value workflows. Keep the snapshot schema narrow, deterministic, and reviewable. Let `@attractor/core` continue owning detailed semantic coverage, while `@attractor/cli` owns end-to-end contract regressions.
