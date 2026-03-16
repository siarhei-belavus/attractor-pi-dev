# Node-Scoped Context Artifacts Plan

## Objective

Implement a two-layer context model in Attractor so pipeline execution keeps:

- the existing flat latest-value context for routing and backward compatibility
- a new node-scoped artifact layer for provenance-safe handoff across non-adjacent stages

This plan assumes the user-facing prompt injection feature will use the simple DSL form:

```dot
reviewer [
  prompt="@prompts/review.md",
  context_keys="node.context_scan.last_response,node.validate.tool.output"
]
```

The implementation must make those node-scoped keys available automatically after stage execution, without requiring handlers to duplicate writes manually.

## Scope

In scope:

- add automatic node-scoped context artifacts for built-in handler outputs
- preserve existing flat context keys unchanged
- define how downstream stages address node-scoped keys
- add prompt injection support for `context_keys`
- add docs, validation, debug artifacts, and tests for the new model

Out of scope for this change:

- replacing flat context entirely
- changing existing edge-condition syntax
- inventing a full context query language
- adding interpolation syntax inside prompt bodies
- changing backend-specific tool semantics

## Desired End State

When a node completes, Attractor must:

1. keep writing the current flat keys such as `last_response`, `tool.output`, `outcome`, and `parallel.results`
2. also persist the same values under deterministic node-scoped keys such as:
   - `node.context_scan.last_response`
   - `node.validate.tool.output`
   - `node.parallel_review.parallel.results`
3. allow later LLM nodes to request those node-scoped values via `context_keys`
4. render requested values into the final prompt under a workflow-handoff section
5. emit debug artifacts that show requested keys, resolved values, missing values, and final rendered prompt

The design must remain additive and must not break existing graphs that rely only on flat keys.

## Assumptions

- The flat context model remains the source for routing conditions and the latest-value semantics.
- The node-scoped layer is derived automatically by the runner after handler outcomes are applied.
- Node-scoped keys are the canonical format for provenance-safe prompt injection in this feature.
- Missing requested context keys must not fail the node by default; they must render as `<missing>` and emit diagnostics.

## Architectural Decisions

### 1. Two-layer context model

Keep two conceptual layers:

- flat operational layer
  - examples: `last_response`, `tool.output`, `outcome`
  - purpose: routing, retry logic, backward compatibility
- node-scoped artifact layer
  - examples: `node.context_scan.last_response`, `node.validate.tool.output`
  - purpose: prompt handoff, provenance, non-adjacent reuse

Do not replace the flat layer. The node-scoped layer is an additive mirror.

### 2. Node-scoped key format

Use:

```text
node.<node_id>.<context_key>
```

Examples:

- `node.context_scan.last_response`
- `node.review_artifacts.tool.output`
- `node.parallel_review.parallel.results`

This format must be written by the runner automatically after each successful handler outcome application.

### 3. Prompt injection DSL

Add one node attribute:

```dot
context_keys="node.context_scan.last_response,node.validate.tool.output"
```

Rules:

- order is preserved exactly as authored
- values are resolved at runtime
- keys may reference flat keys or node-scoped keys, but docs and examples should prefer node-scoped keys for stable handoff

### 4. Prompt rendering contract

For nodes with `context_keys`, append this block to the prompt sent to the backend:

```md
## Context From Previous Steps

The following artifacts were produced by earlier pipeline steps and are provided as workflow inputs for this stage.
Use them as grounded context, but verify against the repository or direct tool inspection when accuracy matters.

### <human-readable source label>

<rendered value>
```

Rendering rules:

- if the selector is `node.<node_id>.<key>`, use the node label when available, otherwise fall back to node id
- if multiple keys come from the same node, render separate subsections per key
- if the key is flat and not node-scoped, render the key name directly as the heading

### 5. Serialization rules

- string -> inject as-is
- number and boolean -> stringify
- object and array -> pretty JSON fenced block
- missing key -> render `<missing>` and emit warning
- empty string -> render `<empty>`

Do not silently omit missing or empty values.

### 6. Ownership

- runner owns automatic node-scoped mirroring
- prompt preparation layer owns `context_keys` resolution and rendering
- validation owns syntax checks for the `context_keys` attribute
- docs own the distinction between flat keys and node-scoped keys

## Implementation Steps

### Step 1. Extend the spec and choose final terminology

Update docs first so implementation follows a fixed contract.

Required outputs:

- define the two-layer context model
- define node-scoped artifact key format
- define `context_keys` semantics
- define missing-value behavior
- define prompt rendering contract

Files:

- `docs/user/language-spec.md`
- `docs/user/cheatsheet.md`
- `docs/user/cookbook.md`

Do not update `docs/specs/attractor-spec.md` in this change. Treat that file as canonical reference outside the scope of this implementation plan. Document the behavior in user-facing and implementation-facing docs inside this repo instead.

Why first:

- implementation touches several layers
- the naming and behavior must be frozen before code changes

### Step 2. Add parser and graph-model support for `context_keys`

Parse the new node attribute and preserve it in the graph model.

Required behavior:

- accept comma-separated string values
- preserve input order
- trim whitespace around entries
- reject empty entries caused by malformed author input

Likely areas:

- parser
- graph model types
- prepared pipeline transforms if needed

Do not add interpolation support in this step.

### Step 3. Add validation for `context_keys`

Add a lint rule for the new attribute.

Validation must:

- allow dotted keys such as `node.context_scan.last_response`
- reject empty segments and malformed comma-separated syntax
- reject whitespace-only values

Validation must not attempt full dataflow proof in v1.

Optional warning:

- if a selector does not start with `node.` and references a flat key, warn that latest-value semantics may be overwritten by later stages

### Step 4. Add automatic node-scoped mirroring in the runner

After handler context updates are applied and the current node is known, mirror relevant updated keys under `node.<node_id>.<key>`.

Required behavior:

- mirror every key written via `contextUpdates`
- mirror runtime-applied outcome keys that matter for later prompt use, at least:
  - `outcome`
  - `failure.reason` when present
  - `preferred_label` when present
- do not mirror volatile engine internals under `node.<node_id>.internal.*`

The runner must remain the single owner of this mirroring behavior.

Do not require individual handlers to write their own node-scoped copies.

### Step 5. Add prompt injection using `context_keys`

In the core prompt-preparation path, resolve and append requested context values before backend execution.

Required behavior:

- parse authored order from `context_keys`
- resolve values from current runtime context
- render workflow-handoff section
- append to the effective prompt after any base prompt resolution
- preserve compatibility with existing fidelity behavior

Ordering decision:

1. base prompt
2. explicit `context_keys` injection block
3. existing synthetic fidelity preamble behavior remains wherever the current implementation places it today

If implementation inspection shows the fidelity preamble must remain first for correctness, amend docs and preserve that order consistently.

### Step 6. Add debug artifacts for prompt injection

For nodes using `context_keys`, write an additional artifact such as `context-inputs.json`.

The artifact must include:

- requested selectors in authored order
- resolved values
- rendered headings
- missing selectors

The existing `prompt.md` artifact must contain the final rendered prompt actually sent to the backend.

This step is required so the feature is debuggable in live runs.

### Step 7. Update example workflow to use node-scoped handoff

Apply the feature to `examples/parallel-code-review/pipeline.dot`.

Required shape:

- specialists must reference the explicit handoff they need, not rely on latest-value `tool.output`
- the review graph should consume node-scoped outputs such as:
  - `node.context_scan.last_response`
  - `node.validate.tool.output`

If the graph still needs a richer stable handoff than `last_response`, stop and amend the plan rather than silently inventing another temporary mechanism.

### Step 8. Add focused tests

#### Core integration tests

Add tests covering:

- node-scoped keys are mirrored after stage completion
- `context_keys` injects requested values into the final backend prompt
- ordering is stable
- missing values render `<missing>`
- object values render as JSON blocks
- flat latest-value keys still behave as before

#### Validation tests

Add tests covering:

- valid `context_keys`
- malformed `context_keys`
- warnings for flat-key usage if implemented

#### Workflow regression tests

Update example-workflow tests to assert the review workflow now uses explicit handoff selectors where intended.

### Step 9. Run validation and smoke paths

Required validation order:

1. narrow parser/validation tests
2. narrow core integration tests
3. existing example workflow tests
4. `attractor validate examples/parallel-code-review/pipeline.dot`
5. one real packaged or CLI smoke path using the updated workflow

Do not skip the real prompt artifact inspection step.

## Risks

- Prompt size increases when large context values are injected.
- Flat and node-scoped keys may confuse authors if docs are unclear.
- Prompt order may interact subtly with existing fidelity/preamble logic.
- If the runner mirrors too many keys automatically, context growth may become noisy.
- If only `contextUpdates` are mirrored and runtime-applied outcome keys are skipped, authors may get inconsistent behavior.

## Mitigations

- document that node-scoped keys are for handoff; flat keys are for latest-value routing
- keep rendering deterministic and visible in debug artifacts
- start with narrow, explicit serialization rules
- mirror a clearly defined set of keys rather than “everything internal”
- add integration tests specifically around fidelity and prompt assembly order

## Validation Plan

Success means all of the following are true:

- a stage output is available both as a flat latest-value key and as a node-scoped key
- a downstream node can request `node.<node_id>.<key>` via `context_keys`
- the final prompt artifact shows a rendered workflow-handoff section with those values
- missing values are explicit, not silent
- old graphs without `context_keys` continue to run unchanged
- the parallel code-review example no longer relies on implicit previous-stage assumptions for handoff

## Amendment Rule

Implementation must stop and request amendment if any of the following is discovered:

- current prompt-preparation ordering makes explicit injection and fidelity preamble mutually incompatible
- runner context mutation points do not allow reliable node-scoped mirroring without refactoring checkpoint or retry semantics
- the example workflow needs a richer contract than node-scoped `last_response` and `tool.output` can safely provide
- the existing context model already contains a hidden namespaced store that would make this plan redundant or conflicting

If amendment is required, the implementer must:

1. describe the blocker precisely
2. list the smallest safe design alternatives
3. explain how each alternative affects compatibility and docs
4. wait for a human decision before continuing

## Maintainability Note

This design is intentionally conservative:

- keep routing simple by preserving flat latest-value keys
- add provenance through node-scoped mirroring instead of replacing the current model
- make prompt handoff explicit and inspectable

That keeps the feature reviewable and avoids turning prompt files into hidden orchestration programs.
