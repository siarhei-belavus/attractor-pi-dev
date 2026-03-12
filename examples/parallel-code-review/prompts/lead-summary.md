Turn the merged specialist review for `$review_scope` into a human-facing review packet.

Optimize for low human cognitive load:

- Keep only actionable findings.
- Order findings by severity and expected blast radius.
- Make it obvious what to fix first.
- Do not restate every clean check; summarize clean areas briefly.
- If the change looks clean, say so explicitly and mention residual risk.

Return:

1. `Overall risk:` low, medium, or high.
2. `Findings:` a concise bullet list with severity, impact, and evidence.
3. `Cross-rubric patterns:` recurring themes or architectural smells.
4. `Plan alignment:` whether the implementation matches the intended plan, if a plan was supplied.
5. `Human focus:` what a human reviewer should inspect manually next.
6. `Residual risk:` what is still uncertain after the automated review.
