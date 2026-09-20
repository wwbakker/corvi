# @corvi/workflows

## Owns

Application operations that compose capabilities: `inspectChangeRepositories` for the dashboard
read and `startChange` for starting work, including the checkout-method mapping and the operation
journal port.

## Does not own

Git commands, storage primitives, HTTP or JSX, provider calls, or terminal behaviour.

## Public entrypoints

- `@corvi/workflows`: `ChangeWork`, `OperationProgress`, the view/outcome values, and the layer.

## Dependencies

`@corvi/changes`, `@corvi/repositories`, `@corvi/contracts`, and `effect`.

## Invariants

- `startChange` persists `Implementation` before provisioning, continues past a failed repository,
  and returns `PartiallyStarted` with the failures rather than losing them.
- No retry is part of this slice; a partial start stays visible as the outcome, the journal, and
  `Missing` rows.
- The checkout-method enum is mapped here, not in the capabilities.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
