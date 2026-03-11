# Attractor CLI Reference

## Synopsis

```
attractor <command> [options]
```

## Commands

### `attractor run`

Execute a pipeline from a DOT file.

```
attractor run <file.dot> [options]
```

**Options:**

| Flag                  | Description |
|-----------------------|-------------|
| `--simulate`          | Run in simulation mode (no LLM calls). Stages return canned responses. |
| `--auto-approve`      | Auto-approve all human gates (selects the first option). |
| `--logs-dir <path>`   | Output directory for logs and checkpoints. Default: `.attractor-runs/<timestamp>`. |
| `--provider <name>`   | LLM provider. Default: `anthropic`. |
| `--model <id>`        | LLM model ID. Default: `claude-sonnet-4-5-20250929`. |
| `--debug-agent`       | Write redacted agent internals to run logs: `system-prompt.md`, `active-tools.json`, `agent-thread.jsonl`. |
| `--set <key=value>`   | Set a pipeline variable. Repeatable. Overrides defaults from `graph[vars]`. |
| `--verbose`           | Show detailed event output (checkpoint saves, stage completions, agent events). |

**Examples:**

```bash
# Run a pipeline
attractor run workflow.dot

# Dry run without LLM calls
attractor run workflow.dot --simulate

# Override pipeline variables
attractor run deploy.dot --set feature=auth --set env=production

# Use a specific model
attractor run workflow.dot --provider openai --model gpt-5.2

# Verbose output with custom log directory
attractor run workflow.dot --verbose --logs-dir ./logs/run-001

# Capture redacted agent diagnostics for extension/tool debugging
attractor run workflow.dot --debug-agent

# Auto-approve human gates (for CI/CD)
attractor run workflow.dot --auto-approve
```

**Output:**

```
Pipeline: MyWorkflow
Goal: Implement the feature
Nodes: 6
Edges: 7
---
[10:30:01] Pipeline started: MyWorkflow
[10:30:01] Stage 1: plan
[10:30:15] Stage 2: implement
[10:30:45] Stage 3: validate
[10:31:02] Stage 4: review

---
Result: success
Completed: plan -> implement -> validate -> review
Logs: .attractor-runs/1707654601000
```

When execution reaches a human gate, the CLI presents choices interactively:

```
[10:30:45] Human gate: Review Changes
  [A] Approve
  [F] Fix
  [R] Reject
Select:
```

### `attractor validate`

Check a DOT file for errors without executing it.

```
attractor validate <file.dot>
```

**Output on success:**

```
Valid pipeline: MyWorkflow (6 nodes, 7 edges)
```

**Output on error:**

```
ERRORS:
  [start_node] Pipeline must have exactly one start node
  [reachability] Node "orphan_node" is not reachable from start
WARNINGS:
  [prompt_on_llm_nodes] Node "plan" has no prompt attribute
```

Exit code 1 on validation errors.

### `attractor serve`

Start an HTTP server for web-based pipeline management.

```
attractor serve [options]
```

**Options:**

| Flag              | Description |
|-------------------|-------------|
| `--port <number>` | Port to listen on. Default: `3000`. |
| `--host <addr>`   | Host to bind to. Default: `127.0.0.1`. |
| `--provider <name>` | LLM provider for served runs. Default: `anthropic`. |
| `--model <id>`    | LLM model ID for served runs. Default: `claude-sonnet-4-5-20250929`. |

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/pipelines` | Start a pipeline. JSON body: `{ "dotSource": "..." }`. |
| `GET`  | `/pipelines/{id}` | Get run status. |
| `POST` | `/pipelines/{id}/steer` | Queue a manager-loop steering message. JSON body: `{ "message": "..." }`. |
| `POST` | `/pipelines/{id}/questions/{qid}/answer` | Submit a human-in-the-loop answer. |
| `GET`  | `/pipelines/{id}/events` | SSE event stream. |

### `attractor steer`

Queue a steering message for a running pipeline through the HTTP server.

```
attractor steer <run-id> --message <text> [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--message <text>` | Steering message to queue. Required. |

Queued steering is process-local and in-memory in this implementation. It may be consumed by the active backend execution in the same process, but it does not survive process restart or checkpoint resume.
| `--port <number>` | Server port. Default: `3000`. |
| `--host <addr>` | Server host. Default: `127.0.0.1`. |

**Examples:**

```bash
attractor steer run-12 --message "Focus on the failing test first"
attractor steer run-12 --message "Please answer the user's open question" --host 0.0.0.0 --port 4000
```

## General Options

| Flag          | Description |
|---------------|-------------|
| `--help`, `-h` | Show help. |

## Run Directory

Each `attractor run` creates a log directory (default: `.attractor-runs/<timestamp>/`) containing:

```
.attractor-runs/1707654601000/
    checkpoint.json              # Serialized checkpoint after each node
    manifest.json                # Pipeline metadata (name, goal, start time)
    plan/
        prompt.md                # Rendered prompt sent to LLM
        response.md              # LLM response text
        status.json              # Node execution outcome
    implement/
        prompt.md
        response.md
        status.json
    artifacts/
        {artifact_id}.json       # File-backed artifacts
```

## Environment Variables

| Variable                  | Description |
|---------------------------|-------------|
| `ATTRACTOR_COMMANDS_PATH` | Comma-separated directories to search for `/command` prompt files (in addition to `.attractor/commands/`). |
| `ATTRACTOR_PI_RESOURCE_DISCOVERY` | Pi extension discovery mode: `auto` (default) or `none`. |
| `ATTRACTOR_PI_RESOURCE_ALLOWLIST` | Comma-separated absolute extension paths to load explicitly (for example `/abs/ext-a.ts,/abs/ext-b.ts`). |

## Extension Prompt Behavior

When using pi extensions, some extensions may modify the effective system prompt at turn start.  
Treat extension selection as a trusted configuration decision and verify extension behavior before enabling it in production workflows.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0    | Success. |
| 1    | Validation error, execution failure, or missing file. |
