# @corvi/agents

## Owns

Corvi-facing agent identity, profiles, and status.

- `./presenter`: the status vocabulary of agent windows — the pane options an agent's reporter
  publishes (`@agent_status`, `@agent_name`, `@agent_session_name`, `@agent_last_message`; the
  reporter protocol of docs/manual/terminals.md) and the `TerminalPresenter`
  that turns them into the page's running/state/attention facts.
- `./profile`: the subagent profile file vocabulary — Markdown with YAML frontmatter (`label`,
  `harness`, `model`, `effort`, `phases`) and the body as the initial prompt. Parsed pure and
  total, exactly like `@corvi/actions/model`: a file is one `Profile` or a list of reasons it is
  not. Model and effort are checked loosely on purpose; a harness catalog changes.
- `./fields`: that vocabulary's documentation — what each field is for, the values it takes, what
  an absent one means — as data the editing UI renders, compiler-pinned to `Profile`'s fields.
- `./discovery`: scope precedence (repository > workspace > global > built-in) and keys
  (`repository:orders-api:reviewer`), pure over files already read.
- `./node`: the filesystem half — the scopes' directories read per call, and the shipped
  `builtins/*.md` (real files in the same format as user files).

## Does not own

A provider's SDK types, the assumption that every agent is a terminal, or the decision to start
anything. The reporters that run inside an agent (`integrations/pi`, `integrations/opencode`)
speak the pane-option protocol of docs/manual/terminals.md and depend on no Corvi package. Starting
a subagent instance — windows, delivery, the message log — belongs to the server's `subagents`
composition, not here.

## Public entrypoints

- `@corvi/agents/presenter`: `agentsWindowPresenter`
- `@corvi/agents/profile`: `Profile`, `parseProfileFile`, `splitFrontmatter`, `SUBAGENT_EFFORTS`
- `@corvi/agents/fields`: `profileFieldDocs`, `ProfileFieldDoc`, `ProfileFieldValues`
- `@corvi/agents/discovery`: `mergeProfileFiles`, `keyOf`, `DiscoveredProfile`
- `@corvi/agents/node`: `discoverProfiles`, `builtinProfilesDir`, `ProfileRoots`

Placeholder filling for prompts lives in `@corvi/actions/render` (the actions package owns the
one renderer).

## Dependencies

`@corvi/contracts` (the wire vocabulary), `yaml` (frontmatter), `effect`. The presenter stays pure
and Node-free; Node access stays in `./node`.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
