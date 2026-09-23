# @corvi/changes

## Owns

Change records and lifecycle, the repository links a change owns, the pure rules over both, and
the file-backed store for them.

## Does not own

Git commands or checkouts, terminal or provider behaviour, HTTP, or dashboard presentation.

## Public entrypoints

- `@corvi/changes/changes`: `ChangeService` and its interface.
- `@corvi/changes/repositories`: `ChangeRepositories` (list/add/remove links).
- `@corvi/changes/rules`: pure rules (`allowedTransition`, `stateOf`, `checkoutLocationOf`).
- `@corvi/changes/store`: the `ChangeStore` port.
- `@corvi/changes/errors`: the capability's tagged errors.
- `@corvi/changes/node`: the file-backed store layer and the services over it.

## Dependencies

`@corvi/contracts` and `effect`. `node:*` imports live only under `src/node/`.

## Invariants

- Links and records share one envelope per change, so a record cannot be written without its
  links; writes replace the file atomically and serialize in-process.
- A missing change reads as no links for read-only queries; adding a link to an unknown change
  fails. `ChangeConflict` exists for a future cross-process revision check.
- Checkout-method policy stays here; the Git operations themselves do not.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
