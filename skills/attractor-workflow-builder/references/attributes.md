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
- `stack.manager_loop.child.id`
- `stack.manager_loop.child.run_id`

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
