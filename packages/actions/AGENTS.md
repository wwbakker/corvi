# @corvi/actions

## Owns

The named actions a change runs from the terminal page: their files, their vocabulary, and
their delivery.

- `./model`: the action file vocabulary — Markdown with YAML frontmatter (`label`, `kind`,
  `target`, `start`, `submit`, `phases`, `notify`, `keepOpen`) and the body — parsed pure and
  total: a file is one `Action` or a list of reasons it is not.
- `./render`: the one placeholder engine (`{id}`, `{title}`, `{branch}`, `{plan}`, `{state}`,
  `{dir}`, `{repos}`), plain for prompts and shell-escaped for commands. This absorbed
  `@corvi/agents/prompt`'s `fillBriefing`.
- `./discovery`: scope precedence (repository > workspace > global > built-in), keys
  (`repository:orders-api:test`), and the brief's compatibility chain (a shadowing `brief.md`,
  then the legacy `ideationPrompt`, then the shipped body).
- `./deliver`: window selection (the window you are on when it is of the right kind, else the
  leftmost of the right kind) and delivery over `@corvi/terminals`' `Sessions`.
- `./node`: the filesystem half — the scopes' directories read per call, and the shipped
  `builtins/*.md` (real files in the same format as user files).

## Does not own

Terminal/session mechanics (`@corvi/terminals`), which windows are agent windows (the app's
presenters say; candidates arrive tagged), the change lifecycle, HTTP, or the UI. Discovery
reads what is on disk at request time and never writes action files: repository actions are
written with the user's IDE or by an agent, never by Corvi.

## Public entrypoints

- `@corvi/actions/model`: `Action`, `parseActionFile`, `splitFrontmatter`, `InvalidActionFile`
- `@corvi/actions/render`: `renderActionBody`, `shellQuote`, `ActionFacts`, `RenderMode`
- `@corvi/actions/discovery`: `mergeActionFiles`, `keyOf`, `resolveBriefTemplate`, the file and
  discovery types
- `@corvi/actions/deliver`: `deliverAction`, `selectTargetWindow`, `CandidateWindow`, `Delivery`
- `@corvi/actions/node`: `discoverActions`, `builtinActionsDir`, `builtinActionBody`,
  `ActionRoots`

## Dependencies

`@corvi/contracts` (the wire vocabulary), `@corvi/terminals` (the `Sessions` delivery runs
over), `yaml` (frontmatter), `effect`. Node access stays in `./node`.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test` (the package's unit
tests live in `test/` here; the terminal behaviour is exercised in the root `test/terminal.test.ts`).
