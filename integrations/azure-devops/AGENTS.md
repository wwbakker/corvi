# @corvi/azure-devops

## Owns

Azure DevOps as a Corvi integration: the `az` client (`src/azure.ts`), pipeline and build reads
(`src/pipelines.ts`), deployable builds and deployments (`src/server.ts`), deploy conventions
and settings (`src/deploySettings.ts`), and the legacy settings reads (`src/legacy.ts`). It
contributes the pipelines card, the deployments page, their routes, and the summary facts.

Settings resolve through the `Settings` capability and `@corvi/configuration/settings`; the
pipeline naming conventions and the wire schemas live in
`@corvi/contracts/integrations/azure-devops`, shared with the web half.

## Does not own

The application's config file (the resolved config keeps the file's unknown keys, which is
where the legacy `azure*` fields are read from) or the git/GitHub side: pull-request numbers
come from `@corvi/github/client` over the recorded integration-to-integration edge.

## Public entrypoints

- `@corvi/azure-devops`: the integration (`IncludedIntegration`) and its contributors
  (`azureDevopsSummaryContributor`, …)
- `@corvi/azure-devops/server`: `deploy`, `deployments`, `versionsFor`, build helpers
- `@corvi/azure-devops/pipelines`: `activeRuns`, `pipelineItems`, `versionInLines`, …
- `@corvi/azure-devops/azure`, `@corvi/azure-devops/deploySettings`, `@corvi/azure-devops/legacy`

## Dependencies

`@corvi/contracts`, `@corvi/configuration`, `@corvi/github` and `@corvi/shell`. No Node
built-ins outside a local path helper, and no application imports.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
