# @corvi/github

## Owns

GitHub's pull requests, checks and issues, as Corvi's first extracted provider integration:
the PR/checks card and summary contributor (`./`), the issues title source, description section
and completion/read step (`./issues`), and the `gh` client the rest of the app also uses for
merge readiness and merging (`./client`).

`./client` runs `gh`/`git` through the package's own `sh`/`shOrThrow`/`shSoft` over the `Shell`
capability (`src/shell.ts`), caches through the `Cache` capability, and reads repository facts
(branch base, remote default, content-in-main) through the `GitFacts` capability the host
provides.

## Does not own

The application's git layer or its git commands' environment; `apps/server` implements
`GitFacts` from `src/vendors/git.ts` and provides it in `capabilitiesLayer`. The client halves
of the cards/issue UI live in `@corvi/web` (`apps/web/src/extensions/*/client.tsx`).

## Public entrypoints

- `@corvi/github`: the PR/checks integration (`IncludedIntegration`) and its contributors
  (`githubSummaryContributor`, `prLooseEnds`)
- `@corvi/github/issues`: the issues integration and its contributors
  (`githubIssuesTitleSource`, `githubIssuesDescriptionSection`, `planIssueClose`,
  `closeIssueOnComplete`, `repoFromRemote`)
- `@corvi/github/client`: the `gh` client (`prItem`, `prSummary`, `createPr`, `mergeReadiness`,
  `refreshReadiness`, `mergePr`, `forgetPrs`, `prNumberOf`, `readiness`, `headRef`,
  `waitingOnYou`, `reviewState`, `repoFromUrl`, `MergeReadiness`, `Stack`)
- `@corvi/github/checks`: `checkItems`, `groupChecks`, `Check`

## Dependencies

`@corvi/contracts` (schemas, capability tags, display helpers) and `@corvi/shell` (the CLI
helpers and the `Shell` capability). No Node built-ins, no application imports.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
