# @corvi/agents

## Owns

Corvi-facing agent session identity, supported capabilities, prompts and status.

- `./presenter`: the status vocabulary of agent windows — the pane options pi publishes
  (`@agent_status`, `@agent_session_name`, `@agent_last_message`) and the `TerminalPresenter`
  that turns them into the page's running/state/attention facts.
- `./prompt`: how a briefing template's placeholders are filled from a change's facts. The
  template itself is configuration.

## Does not own

A provider's SDK types, the assumption that every agent is a terminal, or the decision to
start anything. Provider packages (`@corvi/pi`, `@corvi/opencode`) will depend on contracts,
not on this package; the terminal is where a session happens to live today, not what an agent
is. The app composes the presenter into the window pipeline
(`apps/server/src/terminals/server/presenter.ts`) and supplies the resolved plan path and configured
template.

## Public entrypoints

- `@corvi/agents/presenter`: `agentsWindowPresenter`
- `@corvi/agents/prompt`: `fillBriefing`, `BriefingFacts`

## Dependencies

`@corvi/contracts` (the terminal presenter and window types). No Node built-ins and no effects:
the presenter is pure, and the prompt fill is a string function.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
