# Human Interview Dynamic Prompt Loading Plan

## Objective

Add dynamic prompt loading to `human.interview` in Attractor so a node can load a canonical `HumanPrompt` from a runtime JSON artifact instead of only from static inline `human.questions`.

This plan is intentionally narrow:

- it does not redefine `wait.human`
- it does not redefine durable answer submission, `resume`, or question-store ownership
- it does not add any DeltaPlan-specific prompt schema to Attractor core

This plan covers only:

- dynamic prompt source resolution in Attractor core
- frozen prompt identity across wait/resume
- one concrete DeltaPlan integration contract

## Chosen DeltaPlan Contract

The DeltaPlan integration uses exactly one dynamic prompt source:

- `human.prompt_file`

DeltaPlan does not use `human.prompt_context_key` in this rollout.
DeltaPlan does not keep the current static-superset `human.questions` in this rollout.

The contract is:

1. a DeltaPlan tool step writes a canonical `HumanPrompt` JSON artifact into the run workspace
2. the `clarification_interview` node uses `human.prompt_file` to load that artifact
3. once the node enters `WAITING`, the resolved prompt is frozen in the durable prompt record
4. resume uses the persisted prompt record, not the source artifact

This single choice must be used consistently in the workflow, docs, tests, and validation.

## Source Of Truth

The canonical runtime prompt format is defined by these Attractor core modules:

- type source of truth:
  - `packages/attractor-core/src/handlers/types.ts`
  - exact types: `HumanPrompt`, `HumanPromptQuestion`, `HumanPromptAnswerMap`
- runtime validator source of truth:
  - `packages/attractor-core/src/handlers/human-prompt.ts`
  - exact functions: `validateHumanPrompt`, `validateHumanPromptAnswers`

No second schema source may be introduced for Attractor core.
Any runtime-loaded prompt file must validate through `validateHumanPrompt`.

## Current State

Current Attractor implementation already has:

- `HumanInterviewHandler` in `packages/attractor-core/src/handlers/handlers.ts`
- `human.questions` parsing helpers in `packages/attractor-core/src/handlers/human-prompt.ts`
- `QuestionStore` with durable `prompt` persistence in `packages/attractor-core/src/server/question-store.ts`
- legacy-shape rejection already implemented in `QuestionStore.readRequired()`

Current durable record shape already is:

- `id`
- `runId`
- `nodeId`
- `stage`
- `status`
- `prompt`
- `answers`
- `createdAt`
- `answeredAt`
- `metadata`

The current record definition is:

- `packages/attractor-core/src/server/question-store.ts`
  - exact type: `QuestionRecord`

The current durable persistence assumption for this plan is:

- `prompt` already exists in stored records
- no storage migration is required for this dynamic-loading change
- legacy records that do not contain `prompt` are already rejected and stay rejected

## Desired End State

Attractor core supports three `human.interview` sources in general:

- `human.questions`
- `human.prompt_file`
- `human.prompt_context_key`

But this rollout implements and validates the DeltaPlan integration only through:

- `human.prompt_file`

The runtime behavior must be:

1. if a node has `human.prompt_file`, the path is normalized before runtime execution
2. `HumanInterviewHandler` resolves the prompt from that normalized absolute path
3. the resolved object must pass `validateHumanPrompt`
4. if the interviewer returns `WAITING`, the exact resolved prompt is persisted in `QuestionStore`
5. on resume, when a pending durable prompt record already exists, the handler must validate answers against the persisted `question.prompt`, not by re-reading the file

## Non-Negotiable Rules

### Frozen Prompt Resume Rule

Once a `human.interview` node has produced a pending durable prompt record:

- do not re-read `human.prompt_file` on resume
- do not re-resolve any prompt source attrs on resume
- do not allow source artifact edits to change an in-flight waiting prompt

Resume must use:

- `QuestionStore.get(questionId).prompt`

This is required because `QuestionStore.submitAnswers()` validates against the persisted `question.prompt` today, and `HumanInterviewHandler` must not diverge from that source.

### Exactly-One-Source Rule

Authoring validation must keep the existing exactly-one-source rule across:

- `human.questions`
- `human.prompt_file`
- `human.prompt_context_key`

This plan preserves that rule.

### No Compatibility Shims

Do not add:

- DeltaPlan-specific prompt parsing to Attractor core
- fallback logic from `human.prompt_file` to `human.questions`
- fallback logic from file resolution to context resolution
- re-resolution on resume

## Concrete Attractor Changes

### 1. Add `human.prompt_file` constants and helpers

Update:

- `packages/attractor-core/src/handlers/human-prompt.ts`

Add:

- `HUMAN_INTERVIEW_PROMPT_FILE_ATTR = "human.prompt_file"`
- helper to validate a normalized prompt-file attr value

Do not add DeltaPlan-specific logic here.

### 2. Normalize `human.prompt_file` during preparePipeline

Path normalization must happen before runtime because runtime handlers do not have `dotFilePath`.

Update:

- `packages/attractor-core/src/transforms/index.ts`
  - extend `PromptResolutionTransform.apply()`
- `packages/attractor-core/src/engine/pipeline.ts`
  - keep using `preparePipeline(..., { dotFilePath })`

Required behavior:

- if `human.prompt_file` is relative and `dotFilePath` exists, resolve it against the DOT file directory
- write the normalized absolute path back into `node.attrs["human.prompt_file"]`
- if `dotFilePath` is absent, leave relative values unresolved and let validation/runtime fail fast consistently with existing path-dependent behavior

### 3. Validate authoring contract

Update:

- `packages/attractor-core/src/validation/index.ts`

Required validation behavior:

- `human.questions`, `human.prompt_file`, and `human.prompt_context_key` remain mutually exclusive
- `human.prompt_file` must be a non-empty string
- `human.prompt_context_key` must be a non-empty string
- `human.questions` continues to parse/validate as before

Validation ownership:

- `validation/index.ts` validates authoring attrs
- `human-prompt.ts` validates runtime `HumanPrompt`

Do not duplicate full `HumanPrompt` schema validation in `validation/index.ts`.

### 4. Add runtime file loader for canonical prompts

Add a new resolver module:

- `packages/attractor-core/src/handlers/human-prompt-resolver.ts`

Add one main function:

- `resolveHumanInterviewPrompt(node: GraphNode, context: Context, logsRoot: string): HumanPrompt`

Required behavior:

- if `node.attrs["human.prompt_file"]` exists:
  - read the JSON file from the normalized absolute path
  - parse JSON
  - validate with `validateHumanPrompt`
- if `node.attrs["human.questions"]` exists:
  - keep existing inline path
- if `node.attrs["human.prompt_context_key"]` exists:
  - do not use it in DeltaPlan rollout, but preserve generic support

Resolver must not know about pending question ids or `QuestionStore`.

### 5. Update `HumanInterviewHandler` to freeze the first resolved prompt

Update:

- `packages/attractor-core/src/handlers/handlers.ts`
  - exact class: `HumanInterviewHandler`

Required behavior:

- before asking the interviewer, determine whether this node is resuming an existing pending prompt by reading:
  - `context.getString("internal.waiting_for_question_id")`
- if a pending prompt id exists, pass only a `resumeQuestionId` marker to the interviewer and rely on the durable interviewer to return the persisted prompt-backed answers
- if no pending prompt id exists, resolve the prompt through `resolveHumanInterviewPrompt(...)`
- when validating returned answers in the completed path, use:
  - the persisted prompt from the durable record when resuming
  - otherwise the newly resolved prompt

Implementation note:

- the current unsafe part is that `HumanInterviewHandler` rebuilds the prompt from node attrs before calling `validateHumanPromptAnswers(...)`
- this must be changed so resumed validation uses the persisted durable prompt, matching `QuestionStore.submitAnswers()`

### 6. Preserve durable store contract as-is

Update only as needed:

- `packages/attractor-core/src/server/question-store.ts`
- `packages/attractor-core/src/server/durable-interviewer.ts`

Required stance:

- keep `QuestionRecord.prompt` as the persisted prompt payload
- do not change on-disk schema in this plan
- do not add migration logic

If code changes are needed, they are limited to ensuring resumed callers use the persisted `prompt`.

## Concrete DeltaPlan Changes

### Files to change in `deltaplan-eval`

Update exactly these files:

- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/workflows/attractor/delta-plan-planning/pipeline.dot`
- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/scripts/materialize_clarification_response.py`
- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/SKILL.md`
- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/README.md`

Add exactly one new script:

- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/scripts/materialize_human_prompt.py`

### 1. Replace static-superset interview config

Update:

- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/workflows/attractor/delta-plan-planning/pipeline.dot`

Required edit:

- remove the current inline `human.questions` block from `clarification_interview`
- set:
  - `human.prompt_file="<absolute-or-normalized-run-path-placeholder>"` is not viable because the run path is dynamic

Therefore the workflow must add a tool step that writes a deterministic prompt artifact path and the DOT node must use a stable run-relative file path resolved by variable interpolation before preparation.

Chosen contract:

- add a new tool step before `clarification_interview`:
  - `materialize_human_prompt`
- this step writes:
  - `$run_dir/scenarios/$scenario_id/clarifications/attractor-human-prompt.json`
- `clarification_interview` uses:
  - `human.prompt_file="$run_dir/scenarios/$scenario_id/clarifications/attractor-human-prompt.json"`

Because variables are already expanded before runtime, this keeps DeltaPlan on `human.prompt_file` and avoids `human.prompt_context_key`.

### 2. Add prompt-materialization script

Create:

- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/scripts/materialize_human_prompt.py`

Required behavior:

- read the latest clarification request from scenario status
- read the DeltaPlan request bundle
- convert it into canonical `HumanPrompt`
- write canonical JSON to:
  - `scenarios/<scenario-id>/clarifications/attractor-human-prompt.json`
- print a stable success marker

The script owns DeltaPlan-specific mapping, including:

- `responseType=enum` -> `multiple_choice`
- `responseType=boolean` -> `yes_no` or `confirmation` as explicitly chosen by the DeltaPlan mapping
- `responseType=number|object|string` -> `freeform`

This mapping stays outside Attractor core.

### 3. Keep response materialization separate

Keep and update:

- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/scripts/materialize_clarification_response.py`

Required behavior:

- continue reading:
  - `node.clarification_interview.human.interview.answers`
- continue converting Attractor interview answers into:
  - `response-*.json`

Do not merge prompt-materialization and response-materialization into one script.

## User-Facing Docs To Update

Update Attractor public docs in the same rollout:

- `docs/user/language-spec.md`
- `docs/user/cheatsheet.md`
- `docs/user/cookbook.md`

Required doc changes:

- add `human.prompt_file`
- mention `human.prompt_context_key` as supported generic source
- document the exactly-one-source rule
- document frozen prompt semantics across wait/resume

Update DeltaPlan docs in the same rollout:

- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/SKILL.md`
- `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/README.md`

Required DeltaPlan doc changes:

- remove descriptions that imply the DOT contains the clarification questions inline
- document `materialize_human_prompt.py`
- document the `clarification_interview` step as file-backed dynamic prompt loading

## Exact Tests To Add Or Update

Update or add these Attractor tests:

- `packages/attractor-core/tests/validation.test.ts`
  - add exactly-one-source validation cases for `human.prompt_file`
- `packages/attractor-core/tests/human-interview.test.ts`
  - add `human.prompt_file` success case
  - add resumed validation case that uses persisted prompt instead of re-reading a changed file
- `packages/attractor-core/tests/durable-interviewer.test.ts`
  - add pending-record resume case proving the persisted prompt is reused
- `packages/attractor-core/tests/prompt-resolution.test.ts`
  - add prepare-time normalization case for `human.prompt_file`
- `packages/attractor-core/tests/server.test.ts`
  - keep existing durable answer flow green for `human.interview`

If needed, add one new focused file:

- `packages/attractor-core/tests/human-interview-dynamic-prompt.test.ts`

Update or add these DeltaPlan-side checks:

- smoke the workflow at:
  - `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/workflows/attractor/delta-plan-planning/pipeline.dot`
- assert the generated file exists:
  - `scenarios/baseline/clarifications/attractor-human-prompt.json`
- assert `clarification_interview` enters waiting
- answer via `attractor answer`
- resume via `planning_workflow.py resume`
- mutate `attractor-human-prompt.json` after waiting and before resume, then prove resume still honors the frozen persisted prompt

## Exact Validation Commands

Run validation in this order:

1. `pnpm --filter @attractor/core test -- human-interview`
2. `pnpm --filter @attractor/core test -- durable-interviewer`
3. `pnpm --filter @attractor/core test -- validation`
4. `pnpm --filter @attractor/core test -- prompt-resolution`
5. `pnpm --filter @attractor/core test`
6. DeltaPlan smoke workflow:

```bash
/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/.venv/bin/python \
  /Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/scripts/planning_workflow.py start \
  --workspace-root /Users/Siarhei_Belavus/Projects/explore/deltaplan-eval \
  --input /Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/10\ digits.xlsx
```

Then:

1. inspect the produced run under:
   - `/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/.codex-artifacts/delta-plan/runs/<run-id>/`
2. verify:
   - `scenarios/baseline/clarifications/attractor-human-prompt.json` exists
   - `status.json` reports waiting
3. answer:

```bash
attractor answer \
  --run "<run-id>" \
  --prompt "<prompt-id>" \
  --answers '{"estimate_profile":{"value":"ai"},"monthly_capacity":{"value":"[{\"month\":1,\"roleFtes\":{\"Development\":1.0,\"QA\":1.0}}]"},"ai_contingency":{"value":"yes"},"first_solve_confirmation":{"value":"confirmed"}}'
```

4. before resume, edit `attractor-human-prompt.json` to a different prompt and verify that resume still succeeds against the frozen persisted prompt:

```bash
/Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/.venv/bin/python \
  /Users/Siarhei_Belavus/Projects/explore/deltaplan-eval/skills/delta-plan-roadmap-planning/scripts/planning_workflow.py resume \
  --run-dir "/absolute/path/to/.codex-artifacts/delta-plan/runs/<run-id>"
```

## Amendment Rule

Stop and amend only if one of these becomes true:

- `PromptResolutionTransform` cannot safely normalize `human.prompt_file` with existing variable expansion order
- `HumanInterviewHandler` cannot access the persisted prompt on resume without a small explicit collaborator seam from durable interviewer or question store
- DeltaPlan cannot express the canonical prompt artifact at a stable run-relative path

If amendment is needed:

1. document the exact blocking file/function
2. state whether the fix belongs in Attractor core or `deltaplan-eval`
3. propose one concrete replacement design, not multiple options
4. wait for a human decision
