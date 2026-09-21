# @corvi/contracts

## Owns

Canonical shared boundary values: branded IDs, decoded records, and request/response schemas
used by more than one package or across the server/client boundary.

## Does not own

Services, I/O, application rules, capability errors, or any package's internal types. Pure data
utilities only; no Node, Bun, or native imports.

## Public entrypoints

- `@corvi/contracts/paths`: `AbsolutePath`
- `@corvi/contracts/changes`: `Change`, phases, `ChangeId`, repository link values
- `@corvi/contracts/api`: `RepositoryView`/`StartOutcome` and the change record/page wire schemas
  (`ChangeWireSchema`, summary, cards, tabs, widgets, repo states, text, settings view, workspaces)
- `@corvi/contracts/config`: the config file and resolved-config schemas, workspace ids/names

## Dependencies

`effect` (schema/data utilities) only. See the [architecture guide](../../docs/guides/architecture.md)
for the dependency graph and [API design](../../docs/guides/api-design.md) for schema rules.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
