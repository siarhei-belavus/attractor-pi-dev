Review `$review_scope` in `$repo_path` only through the integration and implicit-assumptions rubric.

Focus on:

- Whether the artifact packet and context-scan summary actually give enough grounded input for the downstream reviewers.
- Fit with existing auth, state, error handling, API, persistence, and workflow patterns.
- Assumptions that look plausible in isolation but are likely wrong in this codebase.
- Regressions at system boundaries, especially where multiple components meet.
- Missing compatibility with real calling flows, not toy paths.

Return:

1. `Verdict:` `clean` or `issues`.
2. `Findings:` a concise bullet list ordered by severity.
3. `Broken assumptions:` the hidden assumptions you think are most risky.
4. `Evidence:` files, interfaces, or flows inspected.

If you find nothing material, say `No integration findings.`
