# Extensions Integration Plan

## Objective

- Enable extensions in Attractor runs without breaking provider-specific tool behavior.
- Support explicit extension enablement (allowlist) with pi-specific configuration.
- Add focused debug mode for agent/runtime internals via `--debug-agent`.
- Configure extension resource policy via environment variables (no CLI flags).

## Scope

### In scope

1. Pi-specific resource policy via environment variables:
   - `ATTRACTOR_PI_RESOURCE_DISCOVERY=auto|none` (default `none`; `auto` is explicit opt-in)
   - `ATTRACTOR_PI_RESOURCE_ALLOWLIST=/abs/a.ts,/abs/b.ts` (comma-separated)
2. Pi backend mapping for explicit extension loading.
3. Safe session wiring that does not overwrite extension runtime tool stack.
4. Provider-aware active tool policy (`edit` vs `apply_patch`).
5. Debug artifacts behind `--debug-agent`.

### Out of scope

1. Dashboard rendering and UI controls.
2. Changes to external provider APIs.
3. Non-additive breaking changes to existing CLI workflows.

## Known Limitation

- Some pi extensions may override the effective system prompt on turn start.
- This is an accepted constraint: extension selection is an operator responsibility.
- We explicitly rely on extension curation rather than hard-blocking prompt-overriding extensions.
- `--debug-agent` is the primary diagnostic path to inspect the effective prompt and detect overwrites.

## Phased Implementation

### Phase 1: Pi Policy and Plumbing

1. Add env-based policy reader in `backend-pi-dev` (no core contract changes).
2. Parse and validate:
   - `ATTRACTOR_PI_RESOURCE_DISCOVERY=auto|none` (default `none`; `auto` is explicit opt-in)
   - `ATTRACTOR_PI_RESOURCE_ALLOWLIST=/abs/a.ts,/abs/b.ts`
3. Keep defaults backward-compatible (`auto` + empty allowlist).
4. Define precedence and parsing rules:
   - explicit runtime options > env > defaults,
   - invalid values produce warning and fallback to defaults.

### Phase 2: Pi Backend Session Wiring

1. In backend/session initialization, use resource loader configuration:
   - autodiscovery enabled/disabled by policy,
   - explicit extension paths from allowlist.
2. Stop direct tool overwrite path that bypasses extension runtime layering.
3. Activate extension lifecycle hooks for non-interactive runs with safe bindings.

### Phase 3: Tool Activation Policy

1. Define deterministic provider policy for active tools:
   - OpenAI/Codex: `apply_patch` active, `edit` inactive.
   - Non-OpenAI: `edit` active, `apply_patch` inactive.
2. Enforce unique active tool names and collision diagnostics.
3. Handle extension name collisions with reserved tool names consistently.

### Phase 4: Debug Mode (`--debug-agent`)

1. Add CLI flag `--debug-agent` for `run` mode.
2. Persist debug artifacts under run logs:
   - `system-prompt.md` (effective prompt used by session),
   - `active-tools.json`,
   - `agent-thread.jsonl` (session/runtime event stream).
3. Apply redaction policy for sensitive arguments/outputs.
4. Keep debug writes opt-in only.

### Phase 5: Documentation and Examples

1. Update CLI reference with:
   - env-based extension resource policy,
   - `--debug-agent` semantics,
   - explicit warning that extensions may override effective system prompt.
2. Add cookbook examples:
   - env allowlist with discovery disabled,
   - troubleshooting with debug artifacts and prompt-overwrite checks.

### Phase 6: Validation and Hardening

1. Unit tests:
   - policy parsing and propagation,
   - tool matrix activation by provider,
   - collision handling.
2. Integration tests:
   - explicit extension allowlist with discovery off,
   - extension tools active during run,
   - debug artifact generation with `--debug-agent`.
3. Regression checks:
   - default run without new flags behaves as before.

## Key Risks

1. Extension runtime partially active due to mixed tool wiring paths.
2. Duplicate/conflicting tools causing non-deterministic model behavior.
3. Debug artifacts leaking sensitive data.

## Mitigations

1. Single tool activation path with deterministic precedence rules.
2. Startup diagnostics for tool collisions and filtered active set dump.
3. Redaction allowlist/denylist for debug serialization.

## Definition of Done

1. Explicit extension enablement works with discovery disabled.
2. Extension runtime remains active during normal pipeline execution.
3. Provider-specific tool policy is deterministic and tested.
4. `--debug-agent` writes prompt/tools/thread artifacts safely.
5. Default behavior remains backward-compatible when new flags are not used.

## Amendment Rule

Stop implementation and request amendment if:

1. Runtime layer cannot support extension activation without direct tool overwrite.
2. Collision policy cannot be made deterministic across providers/extensions.
3. Redaction cannot guarantee safe debug output.
