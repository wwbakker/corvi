# @corvi/repositories

## Owns

Checkout work on concrete locations: inspecting a checkout, switching a branch in place, adding a
linked worktree, and removing one. The Git port and its real adapter.

## Does not own

Change records or repository links, checkout-method policy, change-directory selection, dashboard
presentation, or safety assessment for deletion.

## Public entrypoints

- `@corvi/repositories`: the `Repositories` capability, `CheckoutInspection`, and its errors.
- `@corvi/repositories/git`: the Git adapter port (`Service`, value types, `OperationError`).
- `@corvi/repositories/node`: the real Git and process layers, with nothing left to provide.

## Dependencies

`@corvi/contracts` and `effect`. `node:*` imports live only under `src/node/`; the capability
entrypoint stays platform-free.

## Invariants

- Absence is a value (`{ _tag: "Missing" }`); a failed read is an error, never absence.
- Commands run through the `Command` port without a shell; exit codes are data.
- The adapter never deletes a checkout; `removeWorktree` exists for completion workflows, and no
  first-slice workflow calls it.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
