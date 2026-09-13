# Azure DevOps as an extension

> **Kind:** decision · **Status:** accepted

`ci` is retired. Its card is two cards — `github` (pull requests, checks, mergability) and
`azure-devops` (pipelines, deployments) — and `deployments` merges into `azure-devops`
unchanged. The names are vendors, not features: the extension model is additive
(`docs/guides/extensions.md`), and one vendor's absence must read as silence, not as a hole in
another vendor's tree.

## Card shape

Two cards, not one tree. `github` contributes `repository > pull request > checks`;
`azure-devops` contributes `repository > pipelines > runs`. One card per extension
(`extension-host/api/cards.ts`) rules out a shared tree, and no cross-extension import or new
composition surface is added to get one back.

The merge ref still works: `azure-devops` looks up the pull request number through
`prNumberOf` (`vendors/github.ts`, one cached `prSummary` serving both cards). The
`fallbackChecks` inversion (`count === 0 → checkItems`) dies with the split: github always
shows its checks, azure returns `[]` (no row) when it finds no definitions.

The combined `worstItem([pr, ...pipelines])` verdict splits with the cards. The overview icon
takes the worst across contributions anyway (`dashboard/server/summary.ts`), so nothing is lost
at the level that matters.

## Summary split

`github` owns the `unresolved` fact (only when > 0, as before) and offers the `checks`
verdict. `azure-devops` owns the `pipelines` fact (`N pipelines active` / `pipelines idle`,
fact id unchanged) and offers `pending` when any repo has runs in flight. The host merges;
`worst()` does what the manual join did.

Loose ends go to `github` alone (`prLooseEnds`). Deploys are not per-change, so azure has
none.

## Settings and enablement

The `deployments` declarations move to `azure-devops` with new bag keys
(`extensionSettings.azure-devops`, `workspace.extensionSettings.azure-devops`). The retired
shapes migrate in `src/extension-host/migrate.ts`, run after the built-ins load, in
`settingsViewSync`, and after `writeSettings` — the `863d9b5`/`44cef36` pattern:

- `workspace.extensions`: `ci` → `github` + `azure-devops`, `deployments` → `azure-devops`;
- `extensionSettings.deployments` → `extensionSettings.azure-devops`;
- legacy per-workspace `azure` (`false` → explicit list without `azure-devops`;
  `{ organization, project }` → the same bag);
- legacy flat `azureOrganization`/`azureProject`/`azureDeploy` stay readable through
  `azure-devops/legacy.ts` (from the file, which `load()` preserves) until that fallback is
  removed with the migration.

`azureConfigured`/`azureEnabled` (`src/vendors/azure.ts`) die with the split. Enablement is
the list alone: a workspace without `azure-devops` never starts an `az` process. The
`WorkspaceCard` azure-clearing dies with them. The `azureDeploy` form validation in
`settings.ts:problems()` dies too — there is no extension-validator surface.

## Routes and page

Page id `deployments` → `azure-devops` (`/azure-devops`), routes
`/api/ext/deployments/*` → `/api/ext/azure-devops/*`. No shim: the dispatcher matches by
extension name, nothing persisted references either, and the page bundle moves with the
rename.

## What stays

`vendors/github.ts` keeps the CLI wrappers the core imports directly (`mergeReadiness`,
`mergePr`, `prItem`, `prSummary` for `change/server/complete.ts` and `description.ts`) — the
lifecycle must not depend on an extension. The checkout lookup inside them moves to the
contract's `Changes` capability, provided on routes by `capabilities/web.ts` (`ChangesLive`).
`vendors/azure.ts` is deleted; its contents move to `azure-devops/{azure,pipelines}.ts`.

Purity scope is full capability conversion (`Shell`/`Cache`/`Settings`/`Changes` tags), not
first-party `shSoft`/`swr`/`config` direct reads. That is the out-of-tree requirement, and
doing it now keeps the new extension from inheriting the privilege the old vendors had.

## `az devops configure` fallback

`azDefaults` is a shared cached answer (`az:defaults`, 5 min), not a memoised module var: the
CLI's own configuration is one answer for every workspace, and the cache's single-flight
refresh already shares it. Tests reset it with `clearCache` like every other cached answer.

## Cache keys

`az:…` and `gh:…` key shapes are unchanged across the move, so no cold-cache penalty. The
`versions` memo in `pipelines.ts` stays module-local (a finished run's logs never change);
`azDefaults`' memo is gone in favour of the cache above.
