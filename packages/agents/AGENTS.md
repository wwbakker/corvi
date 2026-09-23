# @corvi/agents

## Owns

Corvi-facing agent session identity, supported capabilities, prompts and status.

- `./presenter`: the status vocabulary of agent windows — the pane options pi publishes
  (`@agent_status`, `@agent_session_name`, `@agent_last_message`) and the `TerminalPresenter`
  that turns them into the page's running/state/attention facts.

## Does not own

A provider's SDK types, the assumption that every agent is a terminal, or the decision to
start anything. A provider's agent integration depends on contracts, not on this package; the
terminal is where a session happens to live today, not what an agent is. The app composes the presenter into the window pipeline
(`apps/server/src/terminals/server/presenter.ts`) and supplies the resolved plan path and configured
template.

## Public entrypoints

- `@corvi/agents/presenter`: `agentsWindowPresenter`

Placeholder filling for prompts moved to `@corvi/actions/render` (the actions package owns the
one renderer).

## Dependencies

`@corvi/contracts` (the terminal presenter and window types). No Node built-ins and no effects:
the presenter is pure.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
