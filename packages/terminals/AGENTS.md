# @corvi/terminals

## Owns

The pure terminal vocabulary shared by the server and the page, and the command window's
presentation.

- `./model`: the platform word, the new-window key test, the CSI-u sequences a terminal cannot
  encode by itself, the command option names a kept/finished window carries, and the
  `CommandFailure`/`NewWindowOptions` types the delivery path shares. No imports.
- `./presenter`: `commandWindowPresenter`, which reads the command option names and says what a
  run window is (finished, wanting you). Pure, over `@corvi/contracts`' presenter types.

The pty, the host, the window registry and the socket bridge live in the application
(`apps/server/src/terminals`); this package holds only what both halves of a window's vocabulary
must agree on.

## Does not own

Agent conversation identity, change transitions, notifications policy, the presenters that
compose the agents integration, or the terminal routes. The presenter aggregation stays in the
app (`apps/server/src/terminals/server/presenter.ts`); the routes stay in
`apps/server/src/terminals/routes.ts` because they are transport.

## Public entrypoints

- `@corvi/terminals/model`: `Platform`, `isNewWindowKey`, `csiuFor`, `COMMAND_*_OPTION`,
  `CommandFailure`, `NewWindowOptions`
- `@corvi/terminals/presenter`: `commandWindowPresenter`

## Dependencies

`@corvi/contracts` (the presenter and raw-window types). No Node built-ins and no `effect`:
session/process execution is the application's capability, not this package's.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
