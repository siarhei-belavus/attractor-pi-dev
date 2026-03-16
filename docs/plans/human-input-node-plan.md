# Human Input Node Plan

## Objective

Add a new explicit handler type, `human.interview`, that collects human-provided data and stores it deterministically in pipeline context without changing the existing meaning of `wait.human`.

This feature must preserve the current `shape=hexagon` / `type="wait.human"` behavior as a multiple-choice routing gate. The new handler must be reusable for freeform and structured operator input across any pipeline, including approvals-with-notes, deployment parameters, operator annotations, incident triage inputs, and override values.

## Current Repo Findings

- `wait.human` is currently implemented as `WaitForHumanHandler` in `packages/attractor-core/src/handlers/handlers.ts`.
- Human interaction is currently modeled around a single `Question` and a single `Answer` in `packages/attractor-core/src/handlers/types.ts`.
- The durable path persists one pending question id in checkpoint and run-state via `internal.waiting_for_question_id`, `Checkpoint.waitingForQuestionId`, and `RunState.pendingQuestionId`.
- `DurableInterviewer` and `QuestionStore` already provide the right lifecycle seam for durable wait/resume, but they assume one question payload and one returned answer.
- The HTTP surface currently exposes one `pendingQuestion` object in `GET /pipelines/{id}` and accepts one `{ value, text? }` answer in `POST /pipelines/{id}/questions/{qid}/answer`.
- The runner already handles resume correctly for waiting human stages, so the main missing capability is a richer prompt/answer contract and a handler that stores answers in context instead of routing by edge.

## Scope

In scope:

- add `type="human.interview"` as a built-in explicit handler
- support one or more questions per node
- support question types `freeform`, `yes_no`, `confirmation`, and `multiple_choice`
- persist pending human-input state durably and resume non-interactively once answers exist
- write deterministic context outputs for downstream nodes
- update CLI/server/docs/tests to match the new contract

Out of scope for this change:

- changing `shape=hexagon` semantics
- replacing `wait.human` with `human.interview`
- adding file-edit-based human input workflows
- adding arbitrary nested schemas or a general form language beyond the four supported question types
- adding multi-select question support

## Desired End State

When a graph contains `type="human.interview"`, Attractor must:

1. parse the node as an explicit built-in handler, independent of shape
2. build a durable human-input prompt containing one or more authored questions
3. stop with `WAITING` when answers are not yet available
4. resume from checkpoint without interactive re-entry once the answers have been submitted
5. write normalized answers into context under deterministic keys
6. let downstream nodes consume those values through normal context access and node-scoped mirroring

At the same time, `wait.human` must continue to:

1. ask one multiple-choice routing question
2. write `human.gate.*` keys exactly as today
3. choose the next edge based on the selected option

## Target Contract

### 1. New handler type

Add a built-in explicit handler type:

```text
human.interview
```

Do not add a new shape mapping for it. Graph authors opt in with `type="human.interview"` on any node shape they choose.

### 2. Durable human prompt model

Replace the current single-question internal contract with a durable prompt contract that can represent both existing gates and the new input collector.

Target terminology:

- `HumanPrompt`
  - `title: string`
  - `stage: string`
  - `questions: HumanPromptQuestion[]`
  - `metadata?: Record<string, unknown>`
- `HumanPromptQuestion`
  - `key: string`
  - `text: string`
  - `type: "freeform" | "yes_no" | "confirmation" | "multiple_choice"`
  - `options?: QuestionOption[]`
  - `default?: string | AnswerValue`
  - `required?: boolean`
- `HumanPromptAnswerMap`
  - `Record<string, Answer>`

Use this one prompt contract in the interviewer, durable interviewer, and question store. `wait.human` must emit a `HumanPrompt` with exactly one `multiple_choice` question. `human.interview` must emit a `HumanPrompt` with one or more authored questions.

Architectural rule:

- the durable prompt model is shared infrastructure for both handlers
- `wait.human` and `human.interview` remain distinct public handler types with distinct semantics
- shared persistence must not blur routing-gate behavior into data-collection behavior

Durable record shape:

- `QuestionStore` remains the storage owner and keeps one JSON file per durable prompt under:
  - `logsRoot/questions/q-0001.json`
- target record shape:
  - `id: string`
  - `runId: string`
  - `nodeId: string`
  - `stage: string`
  - `status: "pending" | "answered" | "skipped" | "timeout" | "cancelled"`
  - `prompt: HumanPrompt`
  - `answers: HumanPromptAnswerMap | null`
  - `createdAt: string`
  - `answeredAt: string | null`
  - `metadata: Record<string, unknown>`
- example persisted record:

```json
{
  "id": "q-0001",
  "runId": "run-123",
  "nodeId": "clarification_interview",
  "stage": "clarification_interview",
  "status": "pending",
  "prompt": {
    "title": "Answer clarification questions",
    "stage": "clarification_interview",
    "questions": [
      {
        "key": "approved",
        "text": "Approve this deployment?",
        "type": "yes_no",
        "required": true
      }
    ],
    "metadata": {}
  },
  "answers": null,
  "createdAt": "2026-03-16T12:00:00.000Z",
  "answeredAt": null,
  "metadata": {}
}
```

Breaking-change rule:

- this is a breaking storage contract change
- do not support backward compatibility for legacy `question`/`answer` records
- do not add dual-read or dual-write logic
- if a stored record does not have `prompt`, fail fast with a precise error instead of attempting migration or compatibility parsing
- existing persisted question-store data is treated as incompatible old data and must not be auto-migrated by runtime code

### 3. Node authoring contract

`human.interview` must read its authored questions from a required node attribute:

```text
human.questions
```

The attribute value must be a JSON array string. Each entry must match `HumanPromptQuestion`.

Example:

```dot
collect_deploy_input [
  type="human.interview",
  label="Collect deployment input",
  human.questions="[
    {\"key\":\"approved\",\"text\":\"Approve this deployment?\",\"type\":\"yes_no\"},
    {\"key\":\"window\",\"text\":\"Deployment window\",\"type\":\"freeform\"},
    {\"key\":\"strategy\",\"text\":\"Release strategy\",\"type\":\"multiple_choice\",\"options\":[{\"key\":\"rolling\",\"label\":\"Rolling\"},{\"key\":\"bluegreen\",\"label\":\"Blue/Green\"}]}
  ]"
]
```

Validation rules:

- the array must contain at least one question
- every question key must be unique within the node
- `multiple_choice` questions must define at least one option
- non-`multiple_choice` questions must not define options
- unknown question types are invalid
- malformed JSON is invalid

Validation ownership:

- `packages/attractor-core/src/validation/index.ts` owns parsing and schema validation of `human.questions`
- the validation layer must parse the JSON string once, validate the authored schema, and report graph diagnostics
- `HumanInterviewHandler` must consume already-validated authored data shape and must not re-implement full schema validation
- runtime code may still do fail-fast invariant checks for corrupted persisted data, but authoring validation must not be duplicated across modules

### 4. Context write contract

`human.interview` must write both aggregate and per-question values into flat context so downstream nodes have a stable deterministic surface.

Required flat keys:

- `human.interview.answers`
  - object map keyed by question key
- `human.interview.<question_key>`
  - normalized scalar value for each question

Normalization rules:

- `freeform` writes the submitted text string
- `yes_no` writes `"yes"` or `"no"`
- `confirmation` writes `"confirmed"` or `"cancelled"`
- `multiple_choice` writes the selected option key

Required-ness and emptiness rules:

- a required question is missing if the answers map does not contain the question key
- a required question is missing if the answer entry exists but `value` is `null` or `undefined`
- for optional questions, an absent key means “no answer supplied” and the handler writes no per-question flat key for that question
- for optional questions, an explicit `null` value is treated the same as no answer supplied
- for `freeform`, the submitted `value` must be a string
- for `freeform`, empty string is allowed only when `required=false`
- for `freeform`, empty string must fail validation when `required=true`
- for `yes_no`, the submitted `value` must be exactly `"yes"` or `"no"`
- for `yes_no`, empty string, absent key on `required=true`, or `null` are invalid
- for `confirmation`, the submitted `value` must be exactly `"confirmed"` or `"cancelled"`
- for `confirmation`, empty string, absent key on `required=true`, or `null` are invalid
- for `multiple_choice`, the submitted `value` must be a non-empty string that matches one of the authored option keys exactly
- for `multiple_choice`, empty string, absent key on `required=true`, or `null` are invalid
- extra answer keys that are not declared in the prompt must fail fast

Additional optional keys:

- `human.interview.<question_key>.label`
  - selected option label for `multiple_choice`
- `human.interview.question_id`
  - durable prompt id that supplied the answers

Do not include the node id in the flat key names. The runner already mirrors updates under `node.<node_id>.*`, which will provide provenance-safe access such as:

- `node.collect_deploy_input.human.interview.answers`
- `node.collect_deploy_input.human.interview.approved`
- `node.collect_deploy_input.human.interview.strategy`

This preserves the existing flat latest-value behavior while also providing deterministic node-scoped access.

### 5. Waiting/resume contract

Keep the existing single pending prompt id flow.

Implementation rule:

- one `human.interview` node creates one durable prompt record, not one record per question

Reason:

- it matches the existing checkpoint/run-state model
- it keeps `WAITING` ownership attached to the node
- it avoids inventing multi-question synchronization in the runner

On resume:

- if the durable prompt record is still pending, return `WAITING` with the same durable prompt id
- if the durable prompt record is answered, the handler must continue non-interactively and write context from the stored answers
- if the durable prompt record is cancelled or invalid, fail fast with a precise error

Idempotency rule:

- repeated `resume` without answers must not create a new prompt record
- repeated `resume` without answers must return the existing pending prompt id unchanged
- prompt creation happens once per waiting node entry unless the original prompt record has been explicitly resolved or cancelled

### 6. HTTP/server contract

Keep the resource path `/pipelines/{id}/questions/{qid}/answer`, but update the payloads to represent a prompt with multiple questions.

Transport rule:

- answers are submitted through one shared answer-submission path for all durable human prompts
- `resume` is not an answer transport and must not accept inline human answers
- `resume` only reloads checkpointed execution state and checks whether stored answers now exist

Shared API rule:

- `wait.human` and `human.interview` use the same HTTP endpoints and the same CLI command family
- the answer transport is keyed by durable prompt id, not by handler type
- external clients must not need separate submission logic for routing gates versus interview prompts

Breaking HTTP rule:

- this is a breaking HTTP contract change
- do not accept the legacy single-answer request body `{ "value": ..., "text": ... }`
- do not add request-shape compatibility shims
- do not add dual response shapes for pending prompts
- all in-repo HTTP clients, tests, and docs must move to the new prompt/answers contract in the same change

Target response shape from `GET /pipelines/{id}` for pending human prompts:

- keep `pendingQuestion` as the field name for now
- change its payload to include:
  - `id`
  - `status`
  - `title`
  - `stage`
  - `questions`
  - `createdAt`

Target submission shape:

```json
{
  "answers": {
    "approved": { "value": "yes" },
    "window": { "value": "after-hours", "text": "after-hours" },
    "strategy": { "value": "rolling" }
  }
}
```

Do not keep the old single-value request body in the new implementation. Update the in-repo callers, tests, and docs to the prompt-answer map directly.

CLI parity rule:

- add one shared CLI answer-submission command for all durable human prompts rather than overloading `resume`
- exact command:
  - `attractor answer --run <run-id> --prompt <prompt-id> --answers <json>`
- required args:
  - `--run`
  - `--prompt`
  - `--answers`
- input format:
  - `--answers` is a stringified `HumanPromptAnswerMap`
- example:
  - `attractor answer --run run-123 --prompt q-0001 --answers '{"approved":{"value":"yes"},"window":{"value":"after-hours","text":"after-hours"}}'`
- `attractor answer` writes answers to the durable prompt record, then `attractor resume ...` continues execution

### 7. CLI contract

Update the console interviewer so it can render and collect answers for every question in a `HumanPrompt`.

Required behavior:

- `wait.human` still renders as a one-question choice gate
- `human.interview` renders each question in order
- CLI auto-approve behavior remains limited to `wait.human`
- when `--auto-approve` encounters `human.interview`, fail fast with a clear error instead of fabricating answers

CLI modes:

- interactive console mode
  - reads answers from stdin and continues in the same process
- durable console mode
  - prints the pending prompt to stdout
  - persists the prompt in the same durable store used by server/API mode
  - exits in `WAITING` without reading stdin
  - relies on shared `answer` + `resume` commands for continuation

Durable console UX rule:

- durable console mode must behave like the API flow, only with console presentation
- it must print the prompt id, stage, and authored questions clearly enough that an operator can answer them via CLI without needing another UI

Transport abstraction rule:

- console is only one transport
- server/API, webhook-driven delivery, or external UI must be able to consume the same durable prompt record and submit the same answer payload
- transport adapters publish prompts and submit answers; they do not change graph semantics or handler behavior

Implementation rule:

- non-interactive durable console flow must be implemented as a separate interviewer class, not by overloading interactive stdin behavior with mode flags inside one large class
- interactive console and durable console implementations may share rendering helpers, but waiting semantics must stay explicit and testable

## Implementation Steps

### Step 1. Freeze the prompt/answer model in core types

Update `packages/attractor-core/src/handlers/types.ts` so the shared interviewer contract models one durable prompt with one or more questions and a keyed answer map.

Required work:

- add `human.interview` to the known handler types and validation allowlist
- introduce `HumanPrompt`, `HumanPromptQuestion`, and keyed answer types
- update interviewer interfaces to consume the new prompt contract
- keep one shared durable prompt contract for both `wait.human` and `human.interview`
- replace the `QuestionStore` record contract in place; do not keep legacy fields alive

Why first:

- every other layer depends on this contract
- it prevents ad hoc per-layer interpretations of “multiple questions”

### Step 2. Add `human.interview` parsing and validation

Teach the graph/validation layer to recognize `type="human.interview"` and validate `human.questions`.

Required work:

- extend validation known-types
- parse `human.questions` from node attrs as authored JSON
- reject invalid question arrays and invalid per-question definitions

Keep authoring strict. Invalid form definitions must fail early in validation, not during runtime.

### Step 3. Implement `HumanInterviewHandler`

Add a new handler in `packages/attractor-core/src/handlers/handlers.ts` and register it in `packages/attractor-core/src/handlers/registry.ts`.

Required behavior:

- build a `HumanPrompt` from node attributes
- call the interviewer
- return `WAITING` with the durable prompt id when answers are not available yet
- on answered resume, normalize answers and emit the context writes defined above
- never route via edge selection

Failure behavior:

- missing required answers fail the node
- invalid answer keys or answer types fail the node
- malformed stored answers fail the node with precise context

### Step 4. Refactor durable interviewer and question store around prompt bundles

Update `packages/attractor-core/src/server/durable-interviewer.ts` and `packages/attractor-core/src/server/question-store.ts` to persist one prompt record that contains all authored questions and, once answered, the keyed answer map.

Required work:

- store `HumanPrompt` instead of the old single-question payload
- store `HumanPromptAnswerMap | null` as the answer payload
- continue using one durable id per waiting node
- reuse the existing “find latest pending for stage” logic against the new prompt shape
- remove support for reading legacy `question`/`answer` record shapes

Do not create one question file per sub-question.

### Step 5. Update runner/server resume surfaces

Keep the current `WAITING` lifecycle, but ensure the resumed node can reconstruct all answered values from the stored prompt record.

Required work:

- keep checkpoint and run-state ownership on one pending prompt id
- update `GET /pipelines/{id}` pending-question serialization to expose the prompt title and question list
- update `POST /pipelines/{id}/questions/{qid}/answer` to accept the keyed answer map
- keep the server-side stale-question and run-mismatch protections
- ensure repeated `resume` with no stored answers returns the same pending prompt id without creating duplicates

### Step 6. Update interactive and test interviewers

Update:

- `ConsoleInterviewer`
- `DurableConsoleInterviewer`
- `AutoApproveInterviewer`
- `QueueInterviewer`
- CLI test harness interviewer

Add:

- one shared CLI answer-submission command for `wait.human` and `human.interview`
- transport-neutral submission helpers that server/webhook/UI integrations can reuse
- CLI mode selection that chooses between interactive stdin collection and durable console wait flow

Required rules:

- `AutoApproveInterviewer` continues to auto-answer a single gate prompt only
- queued/test interviewers can provide keyed answer maps for `human.interview`
- console interaction preserves authored question order
- `resume` never prompts for or accepts inline answers in non-interactive transports
- `DurableConsoleInterviewer` prints prompts and returns `WAITING` without attempting stdin reads

### Step 7. Add focused coverage

Add or update tests at the smallest proving layers.

Core tests:

- `packages/attractor-core/tests/` for handler behavior, context writes, validation failures, and resume
- extend server tests for pending prompt payloads and keyed-answer submission
- keep existing `wait.human` coverage intact to prove no regression

CLI tests:

- add or extend golden coverage only if CLI output contracts change materially

Packaged smoke:

- do not add packaged smoke coverage unless the shipped binary path changes in a way not covered by existing package-local tests

### Step 8. Update docs after code behavior is fixed

Update user-facing docs to distinguish clearly between:

- `wait.human`: routing gate
- `human.interview`: data collection node

Likely files:

- `docs/user/language-spec.md`
- `docs/user/cli-reference.md`
- `docs/user/cookbook.md`
- `docs/user/cheatsheet.md`
- `docs/user/attractor-spec-traceability-matrix.md`

Include at least one example that collects structured deployment parameters and one example that collects approval plus notes without changing branches.

## Key Risks

- The current durable path is built around one answer object. If the keyed answer map is not introduced centrally, the implementation will drift across handler, server, and CLI layers.
- Auto-approve is currently a broad interviewer behavior. If left unchanged, it could silently fabricate `human.interview` answers and produce unsafe automation.
- Flat context keys for multiple `human.interview` nodes will use latest-value semantics. That is acceptable only because node-scoped mirroring already provides provenance-safe access.
- Validation must reject malformed `human.questions` up front. If runtime parsing is left permissive, operators will get late failures after a pipeline has already started.

## Validation Plan

Run validation in this order:

1. `pnpm --filter @attractor/core test -- --runInBand`
2. `pnpm --filter @attractor/cli test`
3. `pnpm --filter @attractor/cli test:golden` only if interactive CLI output changes
4. `pnpm build`

Add explicit assertions for:

- `wait.human` routing is unchanged
- `human.interview` writes the expected flat and node-scoped context keys
- pending prompt records survive restart and resume
- the server rejects stale prompt ids and malformed keyed answers
- `--auto-approve` does not invent `human.interview` values

## Amendment Rule

Stop implementation and amend this plan if any of the following become true:

- the parser or DOT attribute model cannot safely carry JSON-array question definitions
- the current HTTP contract is used externally in a way that makes the direct keyed-answer payload migration unsafe
- the runner cannot preserve one pending prompt id per waiting node without broader checkpoint changes

If amendment is needed:

1. document the blocker with the exact file/module boundary
2. list the smallest viable alternatives
3. explain the impact on handler contract, server payloads, and tests
4. wait for a human decision before continuing

## Maintainability Note

Keep prompt construction, answer normalization, and durable persistence as three separate responsibilities:

- handler owns authored question parsing and context writes
- interviewer owns interaction mechanics
- question store owns durable persistence

Do not hide answer-shape conversions in multiple layers. One shared normalization path in core is the safest design and the easiest to review later.
