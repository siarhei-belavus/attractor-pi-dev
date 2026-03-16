Plan the implementation of `$task` for the `attractor-pi-dev` monorepo.

Work from the current repository state, and stay grounded in the package boundaries:

- Generic engine, parser, runner, manager-loop, steering, and HTTP behavior belongs in `packages/attractor-core`.
- Generic CLI behavior belongs in `packages/attractor-cli`.
- Pi-specific backend/session/provider/resource policy belongs in `packages/backend-pi-dev`.
- Shipped binary wiring belongs in `packages/attractor-pi`.

Treat `$package_scope` as the starting hypothesis for where the change should land. Refine it after reading the code if the architecture points elsewhere.

Produce a concrete plan that:

1. Names the package(s), files, and tests to touch.
2. Calls out the narrowest validation command that should replace or refine `$validation_command`.
3. Explains sequencing, risks, and any docs or prompt files that must stay in sync.
4. Keeps to the repo rules: fix root causes, preserve a single source of truth, avoid compatibility shims, and stay focused on this task.
