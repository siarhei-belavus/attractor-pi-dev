Implement the approved plan for `$task` in `attractor-pi-dev`.

While working:

- Follow the package boundaries and established patterns already used in this repo.
- Prefer type-safe, explicit changes over hidden behavior or dual-path compatibility.
- Keep functions and modules focused; do not introduce parallel abstractions when one project pattern already exists.
- Update the smallest correct test layer for the change:
  - core behavior in `packages/attractor-core/tests`
  - backend pi-dev behavior in `packages/backend-pi-dev/tests`
  - generic CLI behavior in `packages/attractor-cli/tests`
  - packaged binary smoke only when the shipped `attractor` path truly changed
- Update docs only when behavior, workflow authoring guidance, or CLI usage changed.

Before handing off to validation, ensure the code and tests reflect the plan and that unrelated problems are left untouched.
