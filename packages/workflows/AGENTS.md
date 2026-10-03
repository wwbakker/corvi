# @corvi/workflows

## Owns

Application operations that compose capabilities: `inspectChangeRepositories`, the one checkout
policy (`provisionRepository`, `provisionChange`), `startChange`, and the change lifecycle
(`assessCompletion`, `completeChange`, `assessCancellation`, `cancelChange`) with its provider
ports and journaling.

## Does not own

Git commands, storage primitives, HTTP or JSX, provider calls, or terminal behaviour.

## Public entrypoints

- `@corvi/workflows`: `ChangeWork`, `OperationProgress` re-export, the view/outcome values, and
  the layer.
- `@corvi/workflows/lifecycle`: `ChangeLifecycle`, the lifecycle values, and the `PullRequests`,
  `Issues`, and `TerminalSessions` ports.

## Dependencies

`@corvi/changes`, `@corvi/repositories`, `@corvi/contracts`, and `effect`.

## Invariants

- The checkout policy is one sequence — fetch (when there is a remote), provision,
  fast-forward-only — and a fetch that will not answer stops that repository before anything is
  created or moved. A checkout problem is the outcome's data, never a stopped run.
- Checkout runs are serialized per change by the exported `withCheckoutLock` (process-wide),
  which every server checkout operation holds for its whole critical section; the policy itself
  does not take it, and callers must.
- `startChange` persists `Implementation` before provisioning, continues past a failed repository,
  and returns `PartiallyStarted` with the failures rather than losing them. A refresh that could
  not fast-forward reports `LeftAlone` and never blocks the transition; a checkout not on its
  expected branch is a provisioning failure.
- The checkout-method enum is mapped here, not in the capabilities.
- Lifecycle operations are serialized per change (`ChangeOperationInProgress`); acknowledgements
  are facts, not `force: true`; destructive steps recheck before acting; only Corvi-created
  checkouts are removed.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
