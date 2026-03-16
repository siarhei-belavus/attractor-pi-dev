---
name: attractor-workflow-builder
description: Build and modify Attractor DOT workflows for attractor-pi-dev. Use when users want to create, adapt, validate, debug, or explain `.dot` pipelines; choose node shapes or explicit handler types; write edge conditions; configure prompts, variables, model stylesheets, shared thread context, or `context_keys`; or design human gates, tool stages, parallel branches, governance handlers, manager loops, and node-scoped prompt handoff.
---

# Attractor Workflow Builder

Use this skill for workflow authoring in `attractor-pi-dev`.

This repo is not Factorial. Keep the workflow language grounded in Attractor's actual implementation, docs, and tests.

## Start Here

1. Inspect the target `.dot` file and any nearby `prompts/` or `.attractor/commands/`.
2. Read [`references/node-types.md`](references/node-types.md) for the supported shapes and explicit handler types.
3. Read [`references/attributes.md`](references/attributes.md) when you need exact attribute names, context keys, or routing rules.
4. Borrow patterns from repo examples before inventing new syntax:
   - `examples/ralph-wiggum/pipeline.dot`
   - `examples/spec-to-beads/pipeline.dot`
   - `examples/parallel-code-review/pipeline.dot`
   - `packages/attractor-cli/tests/golden/workflows/*.dot`
5. Validate before handoff with the local CLI binary available in the environment:
   - `attractor validate workflow.dot`
   - `attractor-pi validate workflow.dot`

When behavior is unclear, verify against:
- `docs/user/language-spec.md`
- `docs/user/cookbook.md`
- `docs/user/cheatsheet.md`
- `packages/attractor-core/tests/`

## Critical Differences From The Factorial Skill

- Tool execution is `shape=parallelogram` with `tool_command`, not Factorial-style tool nodes such as `tool_name="spawn_agent"`.
- Governance handlers use Attractor's namespaced attributes:
  - `judge.input_key`, `judge.threshold`, `judge.criteria`
  - `failure.input_key`, `failure.hints`
  - `confidence.threshold`, `confidence.score_key`, `confidence.failure_class_key`, `confidence.escalate_classes`
  - `quality.checks` as a JSON array string
- Parallel fan-out uses `shape=component`; fan-in uses `shape=tripleoctagon`.
- Manager supervision is first-class through `shape=house` / `type="stack.manager_loop"`.
- Manager loops now distinguish:
  - a core-managed child pipeline via `graph[stack.child_dotfile]`
  - an attached backend execution via backend capability, not implicit thread/session reuse
- Variables must come from `graph[vars]`; when `vars` is declared, undeclared `$name` references are validation errors.
- Context keys are a closed set produced by the engine and handlers. Do not invent `ctx.*` writes or assume arbitrary LLM output becomes routable context.
- Attractor now has a two-layer context model:
  - flat latest-value keys such as `last_response`, `tool.output`, `outcome`
  - node-scoped mirrors such as `node.context_scan.last_response`, `node.validate.tool.output`
- Use flat keys mainly for routing and backward-compatible latest-value semantics.
- Use `context_keys` plus node-scoped selectors for provenance-safe handoff across non-adjacent stages.
- Prompt resolution supports:
  - inline prompt text
  - `@relative/file.md`
  - `/command` lookup through `.attractor/commands/`, home commands, and `ATTRACTOR_COMMANDS_PATH`

## Authoring Checklist

- Define exactly one `start` node with `shape=Mdiamond`.
- Define at least one `exit` node with `shape=Msquare`.
- Use bare identifiers for node IDs; put human-readable text in `label`.
- Prefer prompt files for long instructions instead of large inline strings.
- Use `thread_id` and `fidelity` intentionally when multiple LLM stages should share context.
- Do not treat `thread_id` as a generic execution handle. It is for session reuse only.
- For prompt handoff, prefer `context_keys="node.<producer>.<key>,..."` over flat keys like `last_response` or `tool.output`.
- Treat `context_keys` as authored-order input selection. Missing selectors render as `<missing>`; empty strings render as `<empty>`.
- Use edge `condition` and `weight` for routing; do not rely on unsupported custom routing fields.
- Keep governance flows deterministic by routing on built-in keys like `outcome`, `human.gate.selected`, `tool.output`, `judge.rubric.*`, or `confidence.gate.*`.
- Validate after edits, then dry-run with simulation if the workflow shape changed.

## Common Patterns

### Linear LLM Flow

```dot
digraph Hello {
    graph [goal="Say hello"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]

    greet [prompt="Say hello to the user"]

    start -> greet -> exit
}
```

### Explicit Node-Scoped Handoff

```dot
digraph ReviewFlow {
    start [shape=Mdiamond]
    exit  [shape=Msquare]

    scan [prompt="@prompts/scan.md"]
    validate [shape=parallelogram, tool_command="pnpm test"]
    review [
        prompt="@prompts/review.md",
        context_keys="node.scan.last_response,node.validate.tool.output"
    ]

    start -> scan -> validate -> review -> exit
}
```

Use this pattern when a later LLM node needs stable artifacts from specific earlier stages rather than whichever flat key was written most recently.

### Implement / Validate Loop

```dot
digraph ImplementLoop {
    graph [goal="Implement and validate a feature"]

    start     [shape=Mdiamond]
    exit      [shape=Msquare]
    plan      [prompt="@prompts/plan.md"]
    implement [prompt="@prompts/implement.md", goal_gate=true]
    validate  [shape=parallelogram, tool_command="pnpm test"]
    gate      [shape=diamond, label="Tests pass?"]

    start -> plan -> implement -> validate -> gate
    gate -> exit      [condition="outcome=success"]
    gate -> implement [condition="outcome!=success", label="Retry"]
}
```

### Human Approval

```dot
review [shape=hexagon, label="Review Changes"]
review -> ship [label="[A] Approve"]
review -> fix  [label="[F] Fix"]
```

### Governance Flow

```dot
judge [type="judge.rubric", prompt="Review the artifact", judge.input_key="last_response", judge.threshold="0.8"]
gate  [type="confidence.gate", confidence.threshold="0.8"]
route [shape=diamond, label="Route"]

judge -> gate -> route
route -> auto  [condition="confidence.gate.decision=autonomous"]
route -> human [condition="confidence.gate.decision=escalate"]
```

### Parallel Fan-Out / Fan-In

```dot
fan_out [shape=component, label="Parallelize", max_parallel=2]
merge   [shape=tripleoctagon, label="Merge"]

start -> fan_out
fan_out -> branch_a
fan_out -> branch_b
branch_a -> merge
branch_b -> merge
merge -> exit
```

For prompt-based fan-in or lead-summary stages, explicitly pull branch outputs through `context_keys` instead of assuming `last_response` or `parallel.results` latest-value behavior is enough.

### Manager Loop

```dot
digraph Managed {
    graph [goal="Supervise a child workflow", stack.child_dotfile="./child.dot"]

    start   [shape=Mdiamond]
    manager [shape=house, label="Manager", manager.actions="observe,steer,wait"]
    exit    [shape=Msquare]

    start -> manager -> exit
}
```

For an attached backend execution, do not try to encode backend handles in DOT attributes. The backend must expose attached execution supervision explicitly; workflow authors only decide whether the manager should supervise a child DOT pipeline or attach to a backend-managed execution exposed at runtime.

## Validation And Debugging

- Validate structure first:
  - `attractor validate workflow.dot`
- Exercise routing without live model calls:
  - `attractor run workflow.dot --simulate --verbose`
- Capture backend/tool diagnostics when needed:
  - `attractor run workflow.dot --debug-agent`
- When a node uses `context_keys`, inspect:
  - `<logsRoot>/<nodeId>/prompt.md`
  - `<logsRoot>/<nodeId>/context-inputs.json`
- Expect `--debug-agent` artifacts to split by meaning:
  - node-level: `<logsRoot>/<nodeId>/system-prompt.md`, `active-tools.json`
  - thread-level: `<logsRoot>/debug/threads/<sessionKey>/session-events.jsonl`, `latest-snapshot.json`
- If a route is surprising, check the relevant built-in context key rather than assuming custom state exists.

## When To Read More

- Use [`references/node-types.md`](references/node-types.md) for quick node selection.
- Use [`references/attributes.md`](references/attributes.md) for exact attribute names, handler outputs, and routable context keys.
- Use `docs/user/cookbook.md` for larger patterns.
- Use `docs/user/language-spec.md` when you need grammar or validation-rule details.
