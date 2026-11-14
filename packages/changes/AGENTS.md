# @corvi/changes

## Owns

Change records and lifecycle (reopening a cancelled change included), the repository links a
change owns, the shelves kept in its directory, the pure rules over them, and the file-backed
stores for them.

## Does not own

Git commands or checkouts, terminal or provider behaviour, HTTP, or dashboard presentation.

## Public entrypoints

- `@corvi/changes/changes`: `ChangeService` and its interface.
- `@corvi/changes/repositories`: `ChangeRepositories` (list/add/remove links).
- `@corvi/changes/rules`: pure rules (`allowedTransition`, `stateOf`, `checkoutLocationOf`).
- `@corvi/changes/store`: the `ChangeStore` port.
- `@corvi/changes/shelves`: the `ShelfStore` port (`shelves/<repository>/<stamp>-<slug>/` with
  `shelf.json` and `changes.patch`).
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
- Cancelling records `cancelledFrom`; reopening (`ChangeService.reopen`) only takes a cancelled
  change back, moves its directory from the archive into its changes root without overwriting
  anything there, and clears `completedAt` and `cancelledFrom`.
- A shelf exists once its `shelf.json` is recorded; a prepared directory with only a patch is not
  listed. Shelf ids are confined to the change's `shelves/`.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
