# Attractor Attributes And Routing Reference

Use this file when you need exact attribute names or want to know which context keys are safe to route on.

## Core Graph Attributes

| Key | Type | Purpose |
|---|---|---|
| `goal` | String | Pipeline goal; also available as `$goal`. |
| `label` | String | Display name for the graph. |
| `vars` | String | Comma-separated variable declarations with optional defaults. |
| `model_stylesheet` | String | CSS-like model config rules. |
| `default_max_retry` | Integer | Global retry ceiling. |
| `retry_target` | String | Graph-level retry jump target. |
| `fallback_retry_target` | String | Secondary retry target. |
| `default_fidelity` | String | Default context fidelity mode. |
| `stack.child_dotfile` | String | Child workflow path for manager loops. |
| `stack.child_autostart` | String | Whether the manager starts the child automatically. |

## Common Node Attributes

| Key | Type | Notes |
|---|---|---|
| `label` | String | Human-readable display text. |
| `shape` | String | Implied handler type unless `type` overrides it. |
| `type` | String | Explicit handler type. |
| `prompt` | String | Inline text, `@file`, or `/command`. |
| `context_keys` | String | Comma-separated context selectors to append into the prompt in authored order. |
| `max_retries` | Integer | Extra attempts after the first run. |
| `goal_gate` | Boolean | Must succeed before the pipeline may exit. |
| `retry_target` | String | Retry jump target for this node. |
| `fallback_retry_target` | String | Secondary retry target. |
| `fidelity` | String | `full`, `truncate`, `compact`, or `summary:*`. |
| `thread_id` | String | Session reuse key for LLM continuity. |
| `class` | String | Comma-separated stylesheet classes. |
| `timeout` | Duration | Example: `900s`, `15m`, `250ms`. |
| `llm_model` | String | Per-node model override. |
| `llm_provider` | String | Per-node provider override. |
| `reasoning_effort` | String | `low`, `medium`, `high`. |
| `auto_status` | Boolean | Auto-success when handler writes no status. |
| `allow_partial` | Boolean | Accept partial success after retries. |

## Edge Attributes

| Key | Type | Purpose |
|---|---|---|
| `label` | String | Caption or routing key. |
| `condition` | String | Boolean guard expression. |
| `weight` | Integer | Higher-priority route among eligible edges. |
| `fidelity` | String | Target-node fidelity override. |
| `thread_id` | String | Target-node thread override. |
| `loop_restart` | Boolean | Restart a fresh run segment. |

## Prompt Resolution

`prompt` supports three forms:

- Inline text:
  - `prompt="Plan the implementation"`
- File include:
  - `prompt="@prompts/plan.md"`
- Command lookup:
  - `prompt="/my:careful-review RFC-006"`

Command lookup searches:
1. The DOT file directory
2. `{project}/.attractor/commands/`
3. `~/.attractor/commands/`
4. `ATTRACTOR_COMMANDS_PATH`

## Prompt Context Injection

Use `context_keys` on LLM-capable nodes when a stage needs explicit workflow handoff from earlier stages.

Example:

```dot
review [
    prompt="@prompts/review.md",
    context_keys="node.context_scan.last_response,node.validate.tool.output"
]
```

Rules:
- Prefer node-scoped selectors in the form `node.<node_id>.<context_key>`.
- Order is preserved exactly as authored.
- Missing selectors render as `<missing>`.
- Empty string values render as `<empty>`.
- Objects and arrays render as pretty JSON blocks in the final prompt.
- Flat selectors still work, but they follow latest-value semantics and may be overwritten by later stages.

## Variables

Declare variables in `graph[vars]`:

```dot
graph [goal="Ship $feature", vars="feature, env=staging"]
```

Rules:
- `$goal` is implicitly available when `graph[goal]` exists.
- Runtime `--set key=value` overrides defaults.
- If `vars` is declared, every `$name` used in `prompt`, `label`, `tool_command`, `pre_hook`, or `post_hook` must be declared.
- `$ARGUMENTS` exists only inside `/command` markdown files.

## Condition Language

Supported operators:
- `=`
- `!=`
- `contains`
- `matches`
- `<`
- `>`
- `<=`
- `>=`

Supported boolean structure:
- `&&`
- `||`
- `!`

No parentheses are supported.

Examples:

```dot
[condition="outcome=success"]
[condition="tool.output contains \"PASS\""]
[condition="human.gate.selected=A"]
[condition="internal.retry_count.implement >= 3"]
```

## Safe Routing Keys

The built-in engine and handlers produce a fixed set of routable keys. Do not assume arbitrary DOT attributes or model responses become context automatically.

For stable prompt handoff, use node-scoped selectors instead of these flat latest-value keys whenever the producer matters.

Available after every node:
- `outcome`
- `preferred_label`
- `current_node`

Available after LLM nodes:
- `last_stage`
- `last_response`

Available after human gates:
- `human.gate.selected`
- `human.gate.label`

Available after tool nodes:
- `tool.output`

Available as node-scoped mirrors after stage completion:
- `node.<node_id>.outcome`
- `node.<node_id>.preferred_label`
- `node.<node_id>.failure.reason`
- `node.<node_id>.last_response`
- `node.<node_id>.tool.output`
- `node.<node_id>.parallel.results`
- any other non-`internal.*` key written via `contextUpdates`

Available after governance nodes:
- `judge.rubric.score`
- `judge.rubric.summary`
- `judge.rubric.result`
- `failure.analyze.class`
- `failure.analyze.summary`
- `failure.analyze.recommendation`
- `confidence.gate.decision`
- `confidence.gate.score`
- `confidence.gate.reason`
- `quality.gate.result`
- `quality.gate.failed_checks`
- `quality.gate.summary`

Available after parallel and fan-in:
- `parallel.results`
- `parallel.fan_in.best_outcome`
- `parallel.fan_in.llm_evaluation`

Available in manager loops:
- `manager.current_cycle`
- `manager.final_cycle`
- `stack.child.status`
- `stack.child.outcome`
- `stack.child.lock_decision`
- `stack.manager_loop.child.id`
- `stack.manager_loop.child.run_id`
- `stack.manager_loop.child.kind`

Available when supervising an attached backend execution:
- `stack.manager_loop.child.attached.backend_execution_ref`
- `stack.manager_loop.child.attached.branch_key`
- `stack.manager_loop.child.attached.node_id`

Available when supervising a managed child pipeline:
- `stack.manager_loop.child.dotfile`

Available for retry-aware routing:
- `internal.retry_count.<node_id>`

## Model Stylesheet

Use `graph[model_stylesheet]` for shared model defaults:

```dot
graph [
    model_stylesheet="
        * { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }
        .code { llm_model: claude-opus-4-6; }
        #review { llm_model: gpt-5.2; llm_provider: openai; reasoning_effort: high; }
    "
]
```

Specificity order:
- `*`
- `.class`
- `#node_id`
- explicit node attributes

## Validation Habits

Check structure first:
- `attractor validate workflow.dot`

Then dry-run behavior:
- `attractor run workflow.dot --simulate --verbose`

When debugging prompt or tool activation:
- `attractor run workflow.dot --debug-agent`

Current debug artifact layout:
- node-level artifacts go under `<logsRoot>/<nodeId>/`
- thread/session history goes under `<logsRoot>/debug/threads/<sessionKey>/`

Do not teach or rely on legacy paths like a run-root `system-prompt.md` or `agent-thread.jsonl`.

For nodes with `context_keys`, also inspect:
- `<logsRoot>/<nodeId>/prompt.md` for the final rendered prompt
- `<logsRoot>/<nodeId>/context-inputs.json` for requested selectors, resolved values, headings, and missing selectors
