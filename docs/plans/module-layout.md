# Module layout restructure

> **Kind:** plan · **Status:** active

`src/core/` and `src/change/` group files by which half they run on, not by what
they do. `src/extensions/` works because each directory is one component with a
shared vocabulary; `core/` is four ideas (domain, substrate, extension host,
vendor clients) and `change/` is three UI destinations stapled to a lifecycle
service. This plan dissolves `core/`, splits `change/`, and renames the rest so
the tree reads like the web app: home list, wizard, change page (dashboard +
terminals), extension pages, settings, workspace switcher.

## What changes for the reader

```
src/
  server.ts               the server's composition root: route tables + cache/chunks bootstrap
  domain/                 pure vocabulary both sides speak (was core/domain, unchanged contents)
  capabilities/           substrate we own: effect idiom, processes, cache, bus, web glue, OS facts
    effect/               errors (taxonomy), tags (Workspace, Shell), support, http, run
    shell.ts              subprocesses: Result, sh/shWithEnv/shOrThrow, envOf, semaphore, trace
    cache.ts              stale-while-revalidate for everything the CLIs answer
    bus.ts                announce + the SSE stream/watcher + its two routes
    web.ts                sameSite/guard + json/bodyOf/attempt/withChange/withWorkspaceParam
    os.ts                 platform facts (isMac, platformName) + IDE tooling copy
  vendors/                clients for their CLIs (was core/integrations): git, github, azure, stacks
  extension-host/         the extension contract + machinery (was core/host), incl. client.tsx,
                          clientChunks.ts, vendor-jsx.ts — and its routes (wizard/pages/ext/cards)
  change/                 one change's lifecycle service: store, schema, create, complete, cancel,
                          titles, description, model (applyPatch), routes. No UI.
  dashboard/              the dashboard tab: summary server + WidgetCard/WidgetRows/PerRepoCard/
                          CompletionCard/EditReposDialog. (Was change/overview.)
  change-page/            the change shell: ChangeView + changeTabs nav. Composes dashboard,
                          extension tabs and the terminal; owns no data. (Was change/client.)
  wizard/                 /new, promoted to top level: Wizard + index face. (Was change/wizard.)
  terminals/              tmux/ttyd sessions + TerminalPane/WindowTabs/CheatSheet. (Was terminal/.)
  workspace/              contexts, config, repo browser + its routes (repos, workspaces list).
  settings/               settings file read/write + its route.
  extensions/             unchanged — the pattern everything else copies.
  app-root/               the page's composition root (was frontend): router, Home list
                          (ChangeCard), Sidebar, shared UI (ActionsMenu, Progress, stateClass),
                          data hooks, + its routes (icons, /* fallback).
```

Renames at a glance: `core/domain` → `domain`, `core/platform/*` →
`capabilities/*`, `core/integrations` → `vendors`, `core/host` → `extension-host`,
`change/overview` → `dashboard`, `change/client` → `change-page/client`,
`change/wizard` → `wizard`, `terminal` → `terminals`, `frontend` → `app-root`,
`change` stays `change` (singular: it is one change's lifecycle).

## Non-goals

- No behaviour change, no URL change, no wire-shape change. Every slice is
  `git mv` + import updates + doc updates, verified green.
- No change to the extension surfaces, the additive model, the SWR honesty rules,
  or the "events carry news" SSE design.
- No logic refactors smuggled in: the `web.ts` / `os.ts` merges are file
  concatenation, nothing more.

One deliberate break: out-of-tree extensions import the contract's path, which
moves (`core/host/api.ts` → `extension-host/api.ts`). There is no stability
promise for them yet (architecture.md says so), and the portability test pins the
new path — but it is a one-line change every out-of-tree author must make, so it
is stated here rather than discovered.

## Decisions

1. **`change` stays singular.** It owns one change's record and transitions and
   has no UI; the home list, dashboard, wizard and change shell are its readers.
2. **`extension-host/` is top-level**, not `extensions/host/`: it is a peer of the
   features, and "is the host itself an extension?" should never need answering.
3. **`app-root/`**, not `app/`: `app` collides with `IWE.app` and `scripts/app/`;
   `app-root` pairs with `server.ts` (the server's composition root).
4. **Capabilities vs vendors is ours vs theirs.** Capabilities are substrate we
   own (processes, cached answers, bus, HTTP glue, OS facts); vendors are clients
   for their CLIs. Vendors may import capabilities + domain; the two
  deen upward edges to features stay documented exceptions (see below), not a
   reason to blur the line.
5. **`capabilities/web.ts`** merges `origin.ts` + `routes/helpers.ts` (one HTTP
   plumbing leaf); **`capabilities/os.ts`** merges `platform.ts` + `tooling.ts`
   (one "the machine we're on" leaf). Both merges are concatenation.
6. **Small client reshuffles, following the imports:**
   `overview/client/ChangeCard.tsx` → `app-root/` (it is the `/` home-list row,
   not dashboard content); `client/changeState.tsx` → `app-root/stateClass.ts`
   (pure, shared by Home/Sidebar/ChangeView; demoted to `.ts`, it has no JSX);
   `overview/client/Progress.tsx` → `app-root/` (generic primitive, also used by
   the deployments extension's dialog); `client/CompletionCard.tsx` and
   `client/EditReposDialog.tsx` → `dashboard/client/` (dashboard content, read
   only through ChangeView today).
7. **`terminal/` → `terminals/`**: the page id, the sidebar label and the route
   all say "terminals"; the directory should too.
8. **Routes colocate per feature** (`<module>/routes.ts`), ending the separate
   `routes/` table: `change`, `dashboard` (summary only), `terminals` (+
   `/terminal-keys.js`), `workspaces` (+ `/api/workspaces`, moved out of the
   settings table — the response shape is unchanged), `settings` (`/api/settings`
   only), `extension-host` (wizard, pages, ext dispatch, card/tab endpoints, +
   `/extensions/:name/client.js` and `/vendor/*`, which serve its chunks),
   `app-root` (`/icons/*`, `/*` fallback). The bus's two endpoints are exported
   from `capabilities/bus.ts` itself — a 2-route table split from its stream buys
   nothing. `server.ts` composes; URL shapes do not move.
9. **Cross-feature client→client imports stay permitted** (ChangeView composing
   dashboard/terminal cards, DeployDialog using Progress): the lint boundary
   guards the server edge, not composition. The server rule is unchanged —
   enter a module through its barrel, never through a server file.

## Dependency rules (to replace the architecture.md section)

- **`domain/`** imports nothing that runs. Unchanged, new path.
- **`capabilities/`** imports `domain`, plus three documented upward edges that
  predate this plan: `web.ts` (the `withChange` glue reads the change store and
  workspace resolution; its `Bridge` type import from `terminals/server/proxy.ts`
  is type-only and likewise carried over) and `bus.ts` (the watcher reads changes,
  windows and the notification setting). Follow-up, not this plan: inject the
  watcher's sources.
- **`vendors/`** imports `domain` + `capabilities`, plus two carried-over
  exceptions: `git.ts` (the worktree engine) reads the change store leaves and
  the workspace config, and `azure.ts` reads the workspace resolution and the
  settings precedence chain. The former is the old "git cannot be colocated"
  scope (archive/refactor-plan.md item 5), restated at its new address; the
  latter predates this plan identically and is listed here so the rule is true.
- **`extension-host/`** imports `domain` + `capabilities` + the documented
  first-party leaves (change store, `vendors/git`, workspace config,
  settings precedence chain). Unchanged semantics.
- **Features** (`change`, `dashboard`, `change-page`, `wizard`, `terminals`,
  `workspaces`, `settings`): server halves import own module + `domain` +
  `capabilities` + `vendors` + extension-host machinery; never a `client/` file
  or `app-root/`. A composing feature additionally imports the server barrels
  of what it composes (`dashboard/server` reads `terminals/server`,
  `extension-host` and `workspace/server` — composition lives in the composer,
  which is why no cycle forms). Client halves import own module + `domain` +
  `app-root/` + the host client contract; never a server file by value.
  Cross-feature client-to-client composition (ChangeView rendering dashboard
  and terminal cards) is permitted; the lint boundary guards the server edge,
  not composition.
- **`app-root/`** imports `domain` + feature client halves + the host client
  contract; never a server file by value. It is the browser's composition root.
- **`server.ts`** imports the route tables, the host and the capabilities
  bootstrap (cache, client chunks). HTTP stays the only client/server boundary.

## Slice 1 — dissolve `src/core`

`git mv` per row; same-depth moves are prefix substitution, the shallower ones
(`domain/`, `capabilities/*` leaves, `src/routes/`) need `../` fixes with `tsc`
as the checklist. Route tables move to interim `src/routes/` unchanged.

| From | To |
|---|---|
| `core/domain/*` (6 files) | `domain/*`, contents unchanged |
| `core/platform/effect/*` (5 files) | `capabilities/effect/*` |
| `core/platform/capabilities/sh.ts` | `capabilities/shell.ts` |
| `core/platform/capabilities/cache.ts` | `capabilities/cache.ts` |
| `core/platform/capabilities/events.ts` | `capabilities/bus.ts` |
| `core/platform/origin.ts` + `core/platform/routes/helpers.ts` | `capabilities/web.ts` (merge) |
| `core/platform/platform.ts` + `core/platform/tooling.ts` | `capabilities/os.ts` (merge) |
| `core/platform/routes/*.ts` (7 files) | `src/routes/*.ts`, contents unchanged |
| `core/integrations/*` (4 files) | `vendors/*`, contents unchanged |
| `core/host/*` (incl. `api/`, `client.tsx`, `clientChunks.ts`, `vendor-jsx.ts`) | `extension-host/*`, contents unchanged |

Prefix map for importers (applied on top of depth fixes):

```
core/domain/                  → domain/
core/platform/effect/         → capabilities/effect/
core/platform/capabilities/sh → capabilities/shell
core/platform/capabilities/cache → capabilities/cache
core/platform/capabilities/events → capabilities/bus
core/platform/origin          → capabilities/web
core/platform/routes/helpers  → capabilities/web
core/platform/routes/         → routes/
core/platform/platform        → capabilities/os
core/platform/tooling         → capabilities/os
core/integrations/            → vendors/
core/host/                    → extension-host/
```

Also in this slice: `server.ts` imports; `scripts/` (`app.ts`, `sh.ts`, rest per
`tsc`); every `test/` import of a moved path; the `builtinPortability` contract
strings (`src/core/host/api.ts` → `src/extension-host/api.ts`, keeping the
`not.toContain("../../")` assertion meaningful); `server.ts`'s build-error hint
still points at the page entry (path update comes with slice 3); path references
in comments of moved files; `eslint.config.js` path groups rewritten (see
below); `architecture.md` layers + rules, `style.md` rules 3/6/7/9,
`effect-conventions.md` path refs, `extensions.md` contract path, README layout
`core` section.

## Slice 2 — split `src/change`

`change/{model.ts,server/*}` stays put — it is already the lifecycle service.
Everything else moves out; `frontend/` is still under its old name here.

| From | To |
|---|---|
| `change/overview/server/*` (index, summary) | `dashboard/server/*` |
| `change/overview/client/WidgetCard.tsx`, `WidgetRows.tsx`, `PerRepoCard.tsx` | `dashboard/client/` |
| `change/overview/client/Progress.tsx` | `frontend/Progress.tsx` |
| `change/overview/client/ChangeCard.tsx` | `frontend/ChangeCard.tsx` |
| `change/client/ChangeView.tsx`, `changeTabs.ts` | `change-page/client/` |
| `change/client/changeState.tsx` | `frontend/stateClass.ts` |
| `change/client/CompletionCard.tsx` | `dashboard/client/` |
| `change/client/EditReposDialog.tsx` | `dashboard/client/` |
| `change/wizard/*` (client/Wizard.tsx, index.ts) | `wizard/*` |

Importers to fix: `app-root`-to-be (`app.tsx`, `Sidebar.tsx`), `ChangeView.tsx`,
`PerRepoCard.tsx`, `DeployDialog.tsx`, tests (`changeTabs`, `changeState`,
`WidgetRows`, `summaryOf`, web/changes tests). Docs: `architecture.md`
(change/dashboard/change-page/wizard sections), README layout.

## Slice 3 — `app-root`, `terminals`, routes colocation

| From | To |
|---|---|
| `frontend/*` | `app-root/*` (all files, incl. `icons/`, `index.html`, slice-2 arrivals) |
| `terminal/*` | `terminals/*` |
| `routes/changes.ts` | `change/routes.ts` |
| `routes/terminals.ts` | `terminals/routes.ts` (+ `/terminal-keys.js` in from assets) |
| `routes/repos.ts` | `workspace/routes.ts` (+ `/api/workspaces` in from settings table) |
| `routes/settings.ts` | `settings/routes.ts` (minus `/api/workspaces`) |
| `routes/extensions.ts` | `extension-host/routes.ts` (+ `/api/changes/:id/tabs` in from the changes table; + `/extensions/:name/client.js`, `/vendor/*` in from assets) |
| `/api/changes/:id/summary` (out of the changes table) | `dashboard/routes.ts` (new) |
| `routes/assets.ts` remainder (`/icons/*`, `/*`) | `app-root/routes.ts` (new) |
| `routes/events.ts` | `capabilities/bus.ts` (`eventsRoutes` export; file deleted) |

`server.ts` composes the new tables; its page-build hint becomes
`bun build src/app-root/index.html`; the icons path becomes
`src/app-root/icons`. Docs: full `architecture.md` + README layout rewrite,
`effect-conventions.md` exclusion list, `extensions.md` paths. Delete
`src/routes/`.

## `eslint.config.js` rewrite (slice 1; slices 2–3 finish their own rows)

- `src/frontend/**` block → `src/app-root/**` (same `browserBoundary("../")`).
- `src/*/client/**` block unchanged in shape.
- Drop the `src/*/*/client/**` block: no nested client halves remain after
  slice 2 (verify by grep, not by memory).
- Extensions block unchanged.
- `src/core/host/client.tsx` block → `src/extension-host/client.tsx`.
- `src/core/domain/**` pure block → `src/domain/**`.
- `model.ts` pure block unchanged.
- `serverImports()`: drop the dead `${up}deploySettings.ts` line (no such file
  exists); add `${up}*/routes.ts` (module-top route tables are server code a
  half must not import); replace the `core/**` group with
  `${up}capabilities/**`, `${up}vendors/**`, `${up}extension-host/**`, keeping
  the re-admit dance for `extension-host/client.tsx`; `domain/**` and
  `**/model.ts` stay re-admitted. Header comment and both messages updated to
  the new paths (`pureBoundary`'s taxonomy reference becomes
  `capabilities/effect/errors.ts`).

## Verification

- Baseline first: `bun test` on the clean tree, so a pre-existing environmental
  failure is known rather than debated per slice.
- Per slice: `bun run typecheck && bun run lint && bun test` (full suite per
  AGENTS.md), plus `git status` showing moves only (+ docs + config).
- Guides must stay true at every commit: each slice updates the docs it
  invalidates; when the plan completes, durable residue goes into `guides/` and
  this file is deleted per the docs convention (and the `docs/README.md` plans
  table row added now is removed then).

## Risks

- **Import churn volume** (slice 1 touches ~150 files). Mitigation: moves are
  mechanical, `tsc` enumerates every miss, tests pin behaviour. Nothing is
  renamed *and* edited in one commit.
- **Out-of-tree contract path break** (stated above; no shim — a shim would
  keep `core/` alive to save one import line).
- **Upward edges preserved, not fixed** (`bus.ts`, `web.ts`, `vendors/git.ts`).
  They are re-documented at their new addresses; unwinding them is a named
  follow-up, not scope creep here.
- **Stale path references in prose/comments.** The string-literal grep (imports
  excluded) enumerates them; each slice updates the ones it moves.
