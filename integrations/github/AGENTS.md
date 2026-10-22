# @corvi/github

## Owns

GitHub's pull requests, checks and issues, as Corvi's first extracted provider integration:
the PR/checks card and summary contributor (`./`), the issues title source, description section
and completion/read step (`./issues`), and the `gh` client the rest of the app also uses for
merge readiness and merging (`./client`).

`./client` runs `gh`/`git` through the package's own `sh`/`shOrThrow`/`shSoft` over the `Shell`
capability (`src/shell.ts`), caches through the `Cache` capability, and reads repository facts
(branch base, remote default, content-in-main) through the `GitFacts` capability the host
provides. Every `gh` command goes through `src/rate-limit.ts` instead of `sh` directly: GitHub's
limit belongs to the token, so one seam owns the gate for the whole process.

A `gh` call costs at least one GraphQL point, so the token's budget is in practice a budget of
calls: the TTLs in `src/client.ts` (`PR_TTL`, `DETAILS_TTL`) and `src/checks.ts` exist to make
the page's several readers share one call, and they are the numbers to change when traffic has to
come down. When the gate is shut the surfaces say so rather than reading empty — a warn row for
the checks, `checks: "warn"` plus one fact for the overview, the sentence on the pull request
row.

## Does not own

The application's git layer or its git commands' environment; `apps/server` implements
`GitFacts` from `src/vendors/git.ts` and provides it in `capabilitiesLayer`. The client halves
of the cards/issue UI live in `@corvi/web` (`apps/web/src/integrations/*/client.tsx`).

## Public entrypoints

- `@corvi/github`: the PR/checks integration (`IncludedIntegration`) and its contributors
  (`githubSummaryContributor`, `prLooseEnds`)
- `@corvi/github/issues`: the issues integration and its contributors
  (`githubIssuesTitleSource`, `githubIssuesDescriptionSection`, `planIssueClose`,
  `closeIssueOnComplete`, `repoFromRemote`)
- `@corvi/github/client`: the `gh` client (`prItem`, `prSummary`, `createPr`, `mergeReadiness`,
  `cachedReadiness`, `refreshReadiness`, `mergePr`, `forgetPrs`, `prNumberOf`, `readiness`, `headRef`,
  `waitingOnYou`, `reviewState`, `repoFromUrl`, `MergeReadiness`, `PrSummary`, `Stack`,
  `REPOSITORY_CONCURRENCY`)
- `@corvi/github/checks`: `checkItems`, `groupChecks`, `Check`
- `@corvi/github/rate-limit`: the seam every `gh` call runs through (`gh`, `ghOrThrow`,
  `ghSoft`), the gate, its reset and its cheap question (`GitHubRateLimited`, `refusalNow`,
  `forgetRateLimit`)

## Dependencies

`@corvi/contracts` (schemas, capability tags, display helpers) and `@corvi/shell` (the CLI
helpers and the `Shell` capability). No Node built-ins, no application imports.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
