# Attractor Node Types Reference

Use this file when choosing a node shape or explicit handler type.

## Shape Mapping

| Shape | Handler Type | Use For |
|---|---|---|
| `Mdiamond` | `start` | Entry point. Exactly one required. |
| `Msquare` | `exit` | Terminal node. At least one required. |
| `box` | `codergen` | Default LLM task. |
| `hexagon` | `wait.human` | Human gate with selectable outgoing edges. |
| `diamond` | `conditional` | Routing point using edge conditions. |
| `component` | `parallel` | Parallel fan-out. |
| `tripleoctagon` | `parallel.fan_in` | Parallel merge / evaluation. |
| `parallelogram` | `tool` | Shell command execution. |
| `house` | `stack.manager_loop` | Supervisor loop over a child workflow. |

## Default LLM Node

`box` nodes are regular LLM stages.

Typical attributes:
- `prompt`
- `context_keys`
- `label`
- `thread_id`
- `fidelity`
- `timeout`
- `max_retries`
- `goal_gate`
- `llm_model`
- `llm_provider`
- `reasoning_effort`

Use `@prompts/file.md` for long prompts.

## Human Gate

`shape=hexagon` pauses for a human decision.

Useful attribute:
- `human.default_choice` for timeout fallback

Routing keys produced:
- `human.gate.selected`
- `human.gate.label`

## Tool Node

`shape=parallelogram` runs a shell command.

Useful attributes:
- `tool_command`
- `pre_hook`
- `post_hook`

Routing key produced:
- `tool.output`

This is the main replacement for the Factorial skill's tool-style nodes.

## Parallel Nodes

`shape=component` fans out to multiple outgoing branches.

Useful attributes:
- `join_policy`
- `error_policy`
- `max_parallel`
- `join_k`
- `join_quorum`

Produced key:
- `parallel.results`

`shape=tripleoctagon` merges branch results.

If the merge stage uses an LLM prompt, prefer explicit `context_keys` for branch handoff instead of assuming flat latest-value context is enough.

Produced keys:
- `parallel.fan_in.best_outcome`
- `parallel.fan_in.llm_evaluation`

## Explicit Governance Types

These are enabled with `type="..."` on a node, usually with `shape=box`.

### `judge.rubric`

Use for structured review over an existing context artifact.

Key attributes:
- `prompt`
- `judge.input_key`
- `judge.threshold`
- `judge.criteria`

Produced keys:
- `judge.rubric.score`
- `judge.rubric.summary`
- `judge.rubric.result`

### `failure.analyze`

Use for deterministic failure classification and follow-up routing.

Key attributes:
- `prompt`
- `failure.input_key`
- `failure.hints`

Produced keys:
- `failure.analyze.class`
- `failure.analyze.summary`
- `failure.analyze.recommendation`

### `confidence.gate`

Use for deterministic autonomy vs escalation routing.

Key attributes:
- `confidence.threshold`
- `confidence.score_key`
- `confidence.failure_class_key`
- `confidence.escalate_classes`

Produced keys:
- `confidence.gate.decision`
- `confidence.gate.score`
- `confidence.gate.reason`

### `quality.gate`

Use for deterministic pass/fail aggregation across multiple checks.

Key attribute:
- `quality.checks`

`quality.checks` must be a JSON array string, for example:

```dot
quality [
    type="quality.gate",
    quality.checks="[{\"label\":\"tests\",\"condition\":\"tests.pass=true\"}]"
]
```

Produced keys:
- `quality.gate.result`
- `quality.gate.failed_checks`
- `quality.gate.summary`

## Manager Loop

`shape=house` supervises a child workflow.

Important attributes:
- `manager.max_cycles`
- `manager.poll_interval`
- `manager.stop_condition`
- `manager.actions`
- `manager.steer_cooldown_ms`

Child workflow wiring:
- `graph[stack.child_dotfile]`
- `graph[stack.child_autostart]`

Manager semantics:
- With `stack.child_dotfile`, the manager supervises a `managed_pipeline`.
- Without a child DOT file, the manager may supervise an `attached_backend_execution` only if the configured backend provides that capability at runtime.
- `thread_id` is not the attached execution identity. Backend-owned execution refs are runtime data, not workflow syntax.

Useful produced keys:
- `stack.child.status`
- `stack.child.outcome`
- `stack.child.lock_decision`
- `stack.manager_loop.child.id`
- `stack.manager_loop.child.run_id`
- `stack.manager_loop.child.kind`
