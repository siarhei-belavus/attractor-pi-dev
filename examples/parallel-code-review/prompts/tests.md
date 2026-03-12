Review `$review_scope` in `$repo_path` only through the tests, checks, and observability rubric.

Focus on:

- Missing or misplaced tests for the changed behavior.
- Gaps between what the change risks and what the automated checks actually prove.
- Opportunities to replace human re-reading with cheaper verification.
- Logging, metrics, assertions, or debug artifacts needed to make failures legible.

Return:

1. `Verdict:` `clean` or `issues`.
2. `Findings:` a concise bullet list ordered by severity.
3. `Needed verification:` the narrowest tests or checks that would raise confidence.
4. `Evidence:` tests, commands, or instrumentation you inspected.

If you find nothing material, say `No test-or-observability findings.`
