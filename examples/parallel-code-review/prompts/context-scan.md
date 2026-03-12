Use only the tools exposed by the current backend for this run. Ignore instructions that mention unavailable tools or agent frameworks outside the active tool list.

Review `$review_scope` in `$repo_path`.

Start by building shared context for the downstream reviewers:

- Treat the previous stage's artifact packet as your primary source of repo state and plan input.
- Inspect the current diff, touched files, and nearby code that anchors the change.
- Identify the subsystems, ownership boundaries, and likely risk hotspots.
- If `implementation_plan_path` is non-empty, read it and extract the intended sequence, constraints, and declared scope.
- Run any lightweight exploration you need so the later reviewers do not waste time rediscovering the shape of the change.
- Use the validation result from the previous stage when relevant, but do not rely on it as the only source of truth.

Return a concise review brief with:

1. Change summary.
2. Touched areas and integration points.
3. Artifact packet summary: git state, diff signal, untracked files, plan input.
4. Plan expectations, if a plan was provided.
5. Risk map: architecture, complexity, edge cases, tests, plan drift.
6. What each specialist should be especially skeptical about.
