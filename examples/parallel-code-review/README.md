# Parallel Multi-Agent Code Review

This example shows how to structure code review as parallel rubric verification instead of one overloaded reviewer prompt.

The design is grounded in the following review principles:

- Parallel rubric review scales better than one giant prompt.
- Verification is cheaper than generation, so review work should be split into focused second-pass checks.
- Human reviewers should read a compact merged packet, not five long reviewer streams.
- If an implementation plan exists, the review should verify alignment against it explicitly.
- AI-generated code needs extra pressure on architecture, complexity, edge cases, and missing tests.

## Review Topology

1. `Context Scan`
   Builds a shared mental model of the change, affected areas, and likely risk hotspots from an explicit artifact packet.
2. `Run Validation`
   Runs a project-specific command such as tests or lint when one is provided. By default the stage is a safe no-op so the example can run in arbitrary repos.
3. `Parallel Rubric Review`
   Fans out to five specialists:
   - architecture and ownership
   - complexity and simplification
   - edge cases and failure modes
   - tests and observability
   - conformance to the implementation plan
4. `Merge Findings`
   Deduplicates and compares the branch outputs.
5. `Lead Summary`
   Produces the human-facing review packet.
6. `Review Packet Decision`
   Lets a human accept the packet, convert it into a fix request, or rerun after the diff changes.

## Why These Rubrics

- `Architecture Review` covers package boundaries, layering, ownership, and root-cause fixes.
- `Complexity Review` pressures unnecessary abstraction, duplicated logic, and overbuilt interfaces.
- `Edge-Case Review` hunts happy-path bias, boundary conditions, and fragile failure handling.
- `Tests And Observability Review` converts quality questions into cheaper verification: tests, checks, logs, and invariants.
- `Plan Conformance Review` checks whether the implementation follows the intended sequence, scope, and constraints when a plan was provided.

## Artifact Loading

Before the LLM stages start, the workflow runs `Collect Review Artifacts`.

That tool stage captures:

- current review scope
- git status
- diff stats
- untracked file list
- implementation plan contents when `implementation_plan_path` is set

`Context Scan` then turns that packet into a compact review brief that the parallel specialists inherit.

## Run It

Validate the workflow:

```bash
attractor validate examples/parallel-code-review/pipeline.dot
```

Run it against a repo:

```bash
attractor run examples/parallel-code-review/pipeline.dot \
  --set repo_path=/path/to/repo \
  --set review_scope="PR 142" \
  --set validation_command="pnpm test" \
  --set implementation_plan_path=/path/to/plan.md
```

If the target repo uses a different stack, override `validation_command` accordingly. If you omit `validation_command`, the validation stage reports `skipped` and the rest of the review still runs. If no plan exists, omit `implementation_plan_path` and the plan-conformance reviewer will report that the check was not applicable.
