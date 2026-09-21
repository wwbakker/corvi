# @corvi/contracts

## Owns

Canonical shared boundary values: branded IDs, decoded records, request/response schemas
used by more than one package or across the server/client boundary, the tagged failure
vocabulary the transport mapper reads, and the request-scoped `Workspace` tag.

## Does not own

Services, I/O, application rules, status-code mapping, or any package's internal types. Pure
data utilities and Effect tags; no Node, Bun, or native imports. HTTP mapping stays at the
transport boundary.

## Public entrypoints

- `@corvi/contracts/paths`: `AbsolutePath`
- `@corvi/contracts/changes`: `Change`, phases, `ChangeId`, repository link values
- `@corvi/contracts/api`: `RepositoryView`/`StartOutcome` and the change record/page wire schemas
  (`ChangeWireSchema`, summary, cards, tabs, widgets, repo states, text, settings view, workspaces)
- `@corvi/contracts/config`: the config file and resolved-config schemas, workspace ids/names
- `@corvi/contracts/errors`: the tagged failures (`NotFoundError`, `BadRequestError`,
  `ConflictError`, `InternalError`, `CliError`, `DecodeError`), `IweError`, `isIweError`,
  `formatError`
- `@corvi/contracts/workspace`: the request-scoped `Workspace` tag (`corvi/Workspace`)

## Dependencies

`effect` (schema/data utilities) only. See the [architecture guide](../../docs/guides/architecture.md)
for the dependency graph and [API design](../../docs/guides/api-design.md) for schema rules.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
