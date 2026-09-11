# Architecture review 1: layout and structure

> **Kind:** review · **Status:** active

A review of the shape of the application — not of individual behaviours, which come
later. It records what the layers are, what the structural problems are, and which
simplifications are worth making, in an order that keeps each step low-risk.

## The shape as it stands

Three server layers plus a React app:

- **Route/feature layer** — `../../../src/server.ts` and the root modules: `changes.ts`,
  `complete.ts`, `cancel.ts`, `summary.ts`, `local.ts`, `commit.ts`, `deployments.ts`,
  `terminal.ts`, and the rest.
- **Vendor layer** — `src/integrations/*` (`git`, `github`, `azure`, `checks`,
  `stacks`), process-spawning CLI adapters, plus `../../../src/sh.ts` and `src/cache.ts`.
- **Extension layer** — the host `../../../src/extensions/index.ts`, the built-ins
  (`agents/`, `git/`, `ci/`, `jira/`, `github-issues/`, `deployments/`), and the
  out-of-tree loader.
- **Client** — `src/web/*.tsx` and `src/web/*.ts`, bundled by Bun.

The extension host is a real, clean idea: contributions are additive, enablement is
per-workspace and read live, built-ins and out-of-tree modules go through the same
install path, and the API is one file (`api.ts`). That part is in good shape.

The two structural themes worth acting on are **the dependency-injection migration is
half-finished at the subprocess seam**, and **the two largest files are grab-bags**.

## 1. Duplicated CLI boilerplate — the cheapest large win

These private helpers are copy-pasted per module:

| helper | copies | files |
|---|---|---|
| `shSoft` (catch timeout → exit 124 `Result`) | **8** | `integrations/{git,github,azure,checks,stacks}.ts`, `deployments.ts`, `repos.ts`, `cancel.ts` |
| `cliJson` / `ghJson` (schema + fallback) | **6** | `integrations/{github,azure,checks,stacks}.ts`, `deployments.ts`, `extensions/github-issues/index.ts` |
| `messageOf` | **6** | `extensions/index.ts`, `complete.ts`, `cancel.ts`, `server.ts`, `extensions/jira/jira.ts` |
| `fs` (`Effect.orDie(tryPromise)`) | **4** | `changes.ts`, `settings.ts`, `repos.ts`, `integrations/git.ts` |
| `worst` (state reducer) | **3** | canonical in `types.ts`, re-implemented in `extensions/ci/index.ts` and `integrations/azure.ts` |

That is roughly **150 lines of near-identical code**, each copy carrying a comment
that explains the same invariant. A single `../../../src/effect/support.ts` (or methods on the
`Shell` service) removes all of it and makes the "timeouts are data, schema failures
fall back" policy live in one place instead of eight. This is the change to do first.

## 2. Two ways to run subprocesses — the DI migration stops halfway

`../../guides/effect-conventions.md` and `api.ts` say the contract is the **`Shell`
capability** (an Effect service, workspace supplied through the R channel). But only
`extensions/github-issues/index.ts` actually uses it. Every other vendor call — all of
`integrations/*`, `deployments.ts`, `terminal.ts`, `repos.ts`, `cancel.ts` — uses the
ambient `shEffect`, which reads the workspace from the `AsyncLocalStorage` shim in
`context.ts` (kept explicitly as `TODO-MIGRATE`).

So there are two parallel dependency-injection systems, and the majority path is the
legacy one. This is also why `context.ts` still exists. Consolidating on `Shell` (with
`shSoft`/`cliJson` folded in, per point 1) would delete the shim, remove the ambient
seam, and make the extension API's stated promise actually true. It is the
highest-leverage *conceptual* cleanup.

## 3. `../../../src/extensions/index.ts` (597 lines) mixes five jobs

One file holds:

- the loaded-extension type plus `normalize`/`install`;
- out-of-tree discovery and dynamic import;
- the built-in list;
- legacy settings migration;
- all the workspace selectors (`cardsFor`, `wizardStepsFor`, `summaryContributorsFor`, …);
- provisioning, status and run execution;
- the route dispatcher and matcher.

Splitting it into `registry.ts`, `discover.ts`, `selectors.ts` and `dispatch.ts`, with
`index.ts` re-exporting, would shrink the blast radius and make the host testable per
concern. `extensions.test.ts` already reaches into `loaded` directly.

A related smell: the host statically imports all six built-ins at module scope, so
importing *any* selector (e.g. `titles.ts` → `titleSourcesFor`) drags in every built-in
and its whole dependency graph. Not fatal, but it makes "just the registry" impossible
to load alone.

## 4. `../../../src/server.ts` (652 lines, 38 route keys) is a single route table

It is well-commented, but every feature's routes live in one literal, all wrapped by
the same `withChange`/`withWorkspaceParam`/`bodyOf` helpers. Composing a `routes`
object from per-domain modules (`routes/changes.ts`, `routes/terminals.ts`,
`routes/repos.ts`, `routes/settings.ts`, `routes/extensions.ts`) would make each
domain's surface reviewable on its own and let each route module import only what it
uses. Bun's `routes` accepts a composed object, so this is mechanical.

## 5. Feature placement is inconsistent — no single rule

- **jira** and **github-issues** live entirely under `../../../src/extensions`: declaration
  *and* implementation (`jira.ts`, `jiraHttp.ts`, `account.ts`).
- **deployments** splits across `src/deployments.ts` + `../../../src/deploySettings.ts` +
  `src/deployConventions.ts` + `src/integrations/azure.ts` + `src/extensions/deployments/`
  (plus its client).
- **git** splits across `../../../src/integrations/git.ts` + `src/extensions/git/`.
- **ci** has no root module; the composition lives in `extensions/ci/index.ts` over two
  integrations.

The README's "Adding an integration" says "the implementation lives where it always
has", which is true but does not give a rule. A consistent convention would help — for
example `src/features/<name>/{index.ts (declaration), server.ts (implementation),
client.tsx}`, with genuinely shared vendor adapters staying in `../../../src/integrations`.
Failing a move, documenting *which* layer owns implementation for each case would
remove the guesswork.

## 6. Naming and documentation drift

- `extensions/agent-state.ts` (a **pi** extension, out-of-tree) sits next to
  `../../../src/extensions` (IWE's extension system). Two meanings of "extension" one
  directory apart.
- Four `deploy*` files at the root (`deployments.ts`, `deploySettings.ts`,
  `deployConventions.ts`) plus `integrations/azure.ts`.
- `../../../src/local.ts` is uncommitted changes and diffs; `integrations/git.ts` also does
  "local changes" (worktree state). The word does double duty.
- The **README "Layout" section is stale**: it lists `src/integrations/index.ts`,
  `src/integrations/jira.ts`, `src/integrations/ci.ts` and `src/web/IssueTable.tsx`,
  none of which exist. It is the first thing a new reader (or agent) reaches for, so
  it is worth fixing.

## 7. Global mutable singletons and a cycle-break pointer

`loaded`, the `config` object refilled via `Object.assign`, the cache `store`,
terminal's `running` map, and events' `clients`/`watcher` are all module-level mutable
state. The `config` refill is deliberate and documented, but it means a settings save
silently mutates every importer's view — powerful, and easy to reason about wrongly.

`src/extensions/presenters.ts` exists only to break a genuine cycle
(`extensions/index → services → events → terminal → extensions/index`) with a
`setPresenterSource` callback installed by the host. It works and is documented, but
the cleaner shape is a leaf `registry.ts` owning `loaded` (with no built-in imports)
that both `terminal.ts` and the host import directly — which also fixes the "importing
a selector loads the world" problem in point 3.

## 8. Legacy/compat surface

Large and intentional, but worth an explicit budget: `change.jira`, `workspace.jira`,
`workspace.azure`, the flat config fields (`jiraAssignee`, `azureOrganization`, …),
`context.ts`, and roughly ten Promise facades (`swr`, `loadCache`, `saveCache`, `sh`,
`provision`, `repoStatus`, `checkoutFor`, `currentBranch`, `unsafeToRemove`,
`repoStates`, …). The docs justify the facades as "tests are Promise-shaped by
contract", which is fair — but that means **the test suite is what forces the dual
API**. A thin test harness that runs Effects directly would let most of these go. Worth
a conscious decision rather than drift.

## 9. Client

`web/app.tsx` inlines URL↔view parsing (`viewOf`/`pathOf`) and the whole app state;
`web/` is about thirty flat files. It is small enough not to hurt yet, but a
`web/router.ts` extracting `View` plus parsing would make the shell readable, and
grouping `web/change/`, `web/settings/`, `web/dialogs/` would match the server-side
"feature" instinct. Low priority.

## Suggested sequence

1. Shared CLI helpers (point 1) — no behaviour change.
2. Finish the `Shell` migration so `context.ts` can go (point 2).
3. Split `extensions/index.ts` and `server.ts` (points 3 and 4).
4. Fix the README layout and settle the feature-placement rule (points 5 and 6).

Points 1–2 are pure simplification; 3 is mechanical; 4 is documentation.

## Deliberately left alone

The additive extension model, the stale-while-revalidate cache design, the "events
carry news, not data" SSE design, and ttyd proxied through our own origin all read as
deliberate and correct. Nothing here proposes changing them.
