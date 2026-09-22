# @corvi/jira

## Owns

Jira as a Corvi integration: the issue vocabulary and HTTP client (`src/jiraHttp.ts`,
`src/jira.ts`), the board/sprint/issue reads, the create/assign/transition flows, the settings
reads for its site and account (`src/legacy.ts`), and the contributions the app composes
(issue card, wizard step, title source, description section, completion start step).

Settings are read from the `Settings` capability (the resolved config) plus the settings
precedence helpers in `@corvi/configuration/settings`; workspace selection uses
`@corvi/configuration/workspaces` with the workspaces the capability carries. The site builders
are pure over those values.

## Does not own

The application's runtime config object, the change store, or the web page. The client half of
the wizard/page lives in `@corvi/web` (`apps/web/src/extensions/jira/client.tsx`).

## Public entrypoints

- `@corvi/jira`: the integration and its app-facing contributions (`moveIssueOnStart`,
  `moveIssueOnComplete`, `planIssueCompletion`, `jiraLooseEnds`, `jiraTitleSource`,
  `jiraDescriptionSection`, …)
- `@corvi/jira/jira`: the flows and site vocabulary (`siteOf`, `siteFor`, `siteOfWorkspace`,
  `globalOf`, `boardIssues`, `createIssue`, `issueByKey`, `moveIssue`, …)
- `@corvi/jira/jiraHttp`: `jiraFetch`, `siteBaseUrl`, `siteCheck`
- `@corvi/jira/account`, `@corvi/jira/legacy`

## Dependencies

`@corvi/contracts`, `@corvi/configuration` and `@corvi/shell`. No Node built-ins outside
`@corvi/configuration/node`'s helpers, and no application imports.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
