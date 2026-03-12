Review `$review_scope` in `$repo_path` only through the architecture and ownership rubric.

Focus on:

- Package or module placement.
- Layering, dependency direction, and responsibility boundaries.
- Root-cause fixes versus bridge code, shims, or duplicated state.
- Whether the solution matches established project patterns.

Return:

1. `Verdict:` `clean` or `issues`.
2. `Findings:` a concise bullet list ordered by severity.
3. `Evidence:` files, flows, or commands you inspected.
4. `Open questions:` only if a real architectural uncertainty remains.

If you find nothing material, say `No architecture findings.`
