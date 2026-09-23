# @corvi/agents

## Owns

Corvi-facing agent session identity, supported capabilities, prompts and status.

- `./presenter`: the status vocabulary of agent windows — the pane options an agent's reporter
  publishes (`@agent_status`, `@agent_name`, `@agent_session_name`, `@agent_last_message`; the
  reporter protocol of docs/manual/terminals.md) and the `TerminalPresenter`
  that turns them into the page's running/state/attention facts.

## Does not own

A provider's SDK types, the assumption that every agent is a terminal, or the decision to
start anything. The reporters that run inside an agent (`integrations/pi`,
`integrations/opencode`) speak the pane-option protocol of docs/manual/terminals.md and depend on
no Corvi package; the terminal is where a session happens to live today, not what an agent is. The app composes the presenter into the window pipeline
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
