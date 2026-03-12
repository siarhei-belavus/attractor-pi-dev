Review `$review_scope` in `$repo_path` only through the implementation-plan conformance rubric.

If `implementation_plan_path` is empty, return `No plan provided; conformance review not applicable.` and do not invent findings.

If a plan was provided:

- Read `implementation_plan_path` first.
- Compare the actual implementation against the planned scope, sequencing, constraints, and validation expectations.
- Look for silent scope creep, skipped steps, reordered dependencies that create risk, and places where the implementation contradicts the plan.
- Distinguish healthy adaptation from unreviewed drift. Small justified deviations are fine; unexplained deviations are not.

Return:

1. `Verdict:` `aligned`, `partial-drift`, or `major-drift`.
2. `Findings:` a concise bullet list ordered by severity.
3. `Missed plan items:` anything planned but not implemented, if relevant.
4. `Unplanned work:` anything implemented without being reflected in the plan, if relevant.
5. `Evidence:` exact plan sections, files, or flows inspected.
