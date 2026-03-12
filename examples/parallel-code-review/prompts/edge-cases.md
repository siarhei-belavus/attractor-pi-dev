Review `$review_scope` in `$repo_path` only through the edge-case and failure-mode rubric.

Focus on:

- Empty, null, boundary, and malformed inputs.
- Failure paths, retries, cleanup, and partial-success behavior.
- Data loss, silent failure, and correctness hazards.
- Security or safety issues that emerge from unusual but realistic inputs.

Prefer concrete scenarios over vague concern.

Return:

1. `Verdict:` `clean` or `issues`.
2. `Findings:` a concise bullet list ordered by severity.
3. `Scenarios to test:` the highest-value manual or automated checks.
4. `Evidence:` files, commands, or cases inspected.

If you find nothing material, say `No edge-case findings.`
