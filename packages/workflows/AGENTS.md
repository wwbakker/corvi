# @corvi/workflows

## Owns

Application operations that compose capabilities: `inspectChangeRepositories` and `startChange`,
and the change lifecycle (`assessCompletion`, `completeChange`, `assessCancellation`,
`cancelChange`) with its provider ports and journaling.

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

- `startChange` persists `Implementation` before provisioning, continues past a failed repository,
  and returns `PartiallyStarted` with the failures rather than losing them.
- No retry is part of this slice; a partial start stays visible as the outcome, the journal, and
  `Missing` rows.
- The checkout-method enum is mapped here, not in the capabilities.
- Lifecycle operations are serialized per change (`ChangeOperationInProgress`); acknowledgements
  are facts, not `force: true`; destructive steps recheck before acting; only Corvi-created
  checkouts are removed.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
