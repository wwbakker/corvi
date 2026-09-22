# @corvi/contracts

## Owns

Canonical shared boundary values: branded IDs, decoded records, request/response schemas
used by more than one package or across the server/client boundary, the tagged failure
vocabulary the transport mapper reads, the request-scoped `Workspace` tag, the capability tags
an effect may require, and the surface shapes an included integration declares.

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
- `@corvi/contracts/capabilities`: the capability tags (`Shell`, `Cache`, `Settings`, `Bus`,
  `ExtensionStore`, `Changes`, `GitFacts`), `ExtensionStoreShape`, `Result`, and the
  `Capabilities` / `Startup` unions; `Workspace` is re-exported here too
- `@corvi/contracts/integration`: what an included integration declares (`IncludedIntegration`,
  `Card`, `Page`, `ChangeTab`, `DashboardWidget`, `WizardStep`, `ExtensionSetting`,
  `WorkspaceSetting`, routes) and the overview contributor shapes (`TitleSource`,
  `SummaryContributor`, `DescriptionSection`, `NamedContribution`)
- `@corvi/contracts/display`: `ago`, `worst`
- `@corvi/contracts/settings-view`: `Settings`, `SettingsView`
- `@corvi/contracts/integrations/*`: the provider wire schemas both halves decode
  (`azure-devops` — including the pipeline naming conventions — `github-issues`, `jira`,
  `leftovers`, `review`)

## Dependencies

`effect` (schema/data utilities) only. See the [architecture guide](../../docs/guides/architecture.md)
for the dependency graph and [API design](../../docs/guides/api-design.md) for schema rules.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
