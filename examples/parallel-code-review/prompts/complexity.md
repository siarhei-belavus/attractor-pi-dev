Review `$review_scope` in `$repo_path` only through the complexity and simplification rubric.

Focus on:

- Unnecessary abstraction or indirection.
- Overbuilt APIs, interfaces, or configuration surfaces.
- Duplication that should collapse to one source of truth.
- Places where a human reviewer would ask: why is this so complicated?

Prefer minimal-sufficiency solutions over plausible completeness.

Return:

1. `Verdict:` `clean` or `issues`.
2. `Findings:` a concise bullet list ordered by severity.
3. `Simpler shape:` the smallest design that would satisfy the need.
4. `Evidence:` files or code paths inspected.

If you find nothing material, say `No complexity findings.`
