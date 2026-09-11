# Architecture

> **Kind:** guide · **Status:** active

IWE is one Bun process that serves an HTTP API and a React page, talks to the vendors' own CLIs
(`git`, `gh`, `az`, `jira`, `tmux`, `ttyd`), and keeps its only state in one directory per
change (`~/changes/<id>/`). Everything else is read live and cached in
[`src/core/platform/capabilities/cache.ts`](../../src/core/platform/capabilities/cache.ts).

## Layers

```
src/
  server.ts            Bun.serve: the core route table, /api/ext/:name/* dispatch, SSE, ttyd ws-proxy
  change/              the change module: model.ts (the edit rule the halves share), server/
                       (schema, store, create, complete, cancel, commit, review, titles,
                       description, index.ts), client/ (the page, the dialogs, the
                       review surface), wizard/ (a submodule: the New change wizard, client/ +
                       index.ts), overview/ (a submodule: the dashboard — server/ composes
                       change, terminal and the host; client/ holds the cards)
  terminal/            the terminal module: model.ts (the new-window key the pane and the
                       injected ttyd script share), server/ (tmux sessions, ttyd spawn, the ws
                       bridge, the presenter merge), client/ (the terminal pane, tabs, cheat
                       sheet)
  workspace/           the workspace module: model.ts (Entry, the repository-browser row),
                       server/ (config loader, file schema, workspace resolution, repository
                       browser), client/ (the switcher, WorkspaceCard, RepoBrowser)
  settings/            the settings module: model.ts (Settings, SettingsView), server/ (settings
                       page read/write, legacySettings), client/ (SettingsPage, SettingsFields)
  core/
    domain/            the pure vocabulary: change.ts, widget.ts, terminal.ts, time.ts, config.ts
                       (Workspace and the resolved Config as well as the ConfigFile shape),
                       settings.ts (the extension-declared setting shapes)
    platform/          the substrate everything stands on: effect/ (errors, http, run, support,
                       tags), capabilities/ (sh, cache, events), origin.ts, platform.ts,
                       tooling.ts, routes/ (the HTTP tables)
    host/              the extension contract and its machinery: api.ts (and api/*.ts),
                       registry.ts, discover.ts, selectors.ts, effects.ts, dispatch.ts,
                       services.ts, clientChunks.ts, vendor-jsx.ts, client.tsx (the page's
                       client-side registry and the extension UI contract), index.ts
    integrations/      vendor CLI wrappers (git, github, azure, stacks)
  extensions/          the built-ins (agents, git, ci, jira, github-issues, deployments,
                       leftovers)
  frontend/            the browser shell and runtime: index.html, styles, the app router, the
                       sidebar, the data hooks, the fetch client and notifications
  deploySettings.ts    the deployments settings, read by the shared azure client and the
                       workspace module
```

The extension host (`src/core/host/index.ts`) loads built-ins and out-of-tree modules through
the same install path and answers the core's one question — which extensions exist for this
workspace — with a filtered list. See [`extensions.md`](extensions.md) for the contract.

## Where a feature's code lives

The rule, applied in `deployments` and `ci`, so a feature is not a scavenger hunt across four
directories:

- **`src/extensions/<name>/`** — the declaration, its wiring, and the feature's own
  implementation and client half. `deployments/server.ts` and `ci/checks.ts` are colocated
  this way.
- **`src/core/integrations/`** — vendor clients genuinely shared by more than one feature: `azure.ts`
  (deployments + ci), `github.ts` (the core's `complete`/`description` + ci) and `git.ts` (the
  core + the git extension).
- **`src/core/platform/`** — the substrate, not a feature: the route tables, the Effect runtime
  plumbing and the capabilities (`sh`, `cache`, `events`) every module runs on.
- **top-level `src/*.ts`** — `server.ts`, the composition root, and `deploySettings.ts`, shared
  by the azure client and the workspace module.

One shared module lives outside the feature folders:

- `src/deploySettings.ts` — read by the shared `azure` client and by the workspace module's
  `workspaces.ts`,
  so moving it would invert the layering.

A feature's pure vocabulary lives with it: `deployments/deployConventions.ts` is needed by both
that extension's server and browser halves, so it sits beside them.

Git cannot be colocated while `src/core/integrations/git.ts` is shared by the core and the git
extension. Item 5 of [`../plans/archive/refactor-plan.md`](../plans/archive/refactor-plan.md) records this
scope.

## What stays core

A thing is core only if it meets at least one of these:

1. **It owns persisted state or an external session.** The `change.json` and `config.json`
   schemas, archive semantics, the change directory, tmux/ttyd sessions.
2. **It defines vocabulary that crosses a boundary** — server↔browser or core↔extensions. The
   `Change` DTO, `Widget`/`SummaryFact`, completion steps, the error taxonomy.
3. **It is a trust or capability boundary.** `Shell`, `Workspace`, `ExtensionStore`, the origin
   guard, HTTP/SSE.
4. **It is the composition root** — it decides when contributions run and merges them: the
   dashboard, the wizard shell, the completion journal, the sidebar shell, the extension host.

The consequences are worth stating because they settle arguments:

- The change **dashboard is core even though every card on it is an extension**: it composes and
  merges. "Review changes" is a good extension candidate because it is a bounded git surface, not
  a composition.
- The **sidebar is core as a shell**; its entries (workspaces, changes, pages, windows) are
  data the server sends. The **change page is core as a shell** too: it composes the core's
  Dashboard and Review with the change tabs its workspace's extensions contribute, and resolves
  a tab id nobody offers back to the dashboard.
- **Terminal presentation is extensible; tmux and ttyd themselves are core furniture.**
- The **git worktree engine is core.** Extensions act on changes; they do not create them.

Deliberately not core: tmux/ttyd internals, the git engine, and any native functionality. The
native hosts provide capabilities (`notify`, dialogs, external links, window lifecycle), which
extensions consume; no module ships per-platform code. A client-side `Host` capability would
follow the server's `Shell`/`Workspace` pattern when it lands.

## Dependency rules

- **`core/domain/**` imports nothing that runs** — types, states, pure operations; no `node:*`,
  no `Bun.*`, no Effect runtime. It is the ubiquitous language every module and the contract
  speak.
- **A module's `model.ts`** is the synchronous logic its halves share. It may import
  `core/domain/**` and the error taxonomy's data types; it performs no effects.
- **A module's `server/` half** may import its own module, `core/domain`, `core/platform`,
  `core/integrations` and the host's server machinery. It must not import a `client/` file or
  anything under `frontend/`. The one deliberate server→`frontend/` edge is
  `core/platform/routes/assets.ts` importing `frontend/index.html`: it is the Bun HTML entry the
  route serves as the `/*` fallback, not frontend logic.
- **A module's `client/` half** may import its own module, `core/domain`, `frontend` and the
  host's client contract. It must not import a `server/` file by value.
- **`frontend/`** may import `core/domain` and module client halves; never a module server by
  value. It is the browser's composition root, the counterpart of the extension host.
- **Modules enter each other through the server half's `index.ts`** (`change/server/index.ts`,
  `terminal/server/index.ts`, and a composing submodule's `change/overview/server/index.ts`),
  never through a server file. Siblings import each other directly, and nothing inside a module
  imports its own barrel, which is what keeps barrels cycle-free. A submodule whose face is a
  browser component re-exports it from a top-level `index.ts` (`change/wizard/index.ts`); client
  components are otherwise imported file-to-file, since a barrel of components would pull every
  one into the page bundle. The deliberate exceptions are leaves a second module needs by value,
  and their reasons are three, not one: `core/host/registry.ts` and `change/server/store.ts`
  break cycles by depending on state rather than on a half; `terminal/server/proxy.ts` is the
  terminal's HTTP boundary, imported directly by the files that speak HTTP so the barrel does
  not drag the ttyd page script into every server consumer; and
  `settings/server/legacySettings.ts` is the one statement of the settings precedence chain,
  shared by the workspace config loader and the top-level deployments settings (see
  [style.md](style.md), rule 7).
- **Submodules are modules.** `change/wizard/` and `change/overview/` have their own aspects and
  their own face, and the same rules apply at every depth. Composition lives in the submodule
  that composes: `overview` depends on `terminal` and the host, so `change/server` does not have
  to, and no cycle forms at any level.
- **The contract (`core/host/api`) imports `core/domain` and the capability and error leaves it
  re-exports** (`Shell`, `Workspace`, the taxonomy, `Result`) — never a module's server or client
  half. The contract therefore does not change when a module is reshaped; it re-exports the
  promised slice of the domain (`Change`, `branchFor`, the widget vocabulary).
- **Out-of-tree extensions import only `core/host/api`**, which is the whole promise. **Built-ins
  are first-party** and may reach into core modules and `core/integrations` today; new built-in
  code uses the contract plus `core/domain` (and `core/integrations` when it needs a shared
  vendor client), so the privilege shrinks by default. There is no stability promise for
  out-of-tree extensions yet.
- **`server.ts`** is the HTTP composition root: it imports `core/platform/routes` and the host.
- **HTTP** is the only client/server boundary — no shared runtime state crosses it.

`eslint.config.js` makes the browser-facing and purity rules structural: a client half or
`frontend/` may not import a server file by value, and a module inherits the boundary by
existing. `core/domain/**` and every `model.ts` may not import `node:*`, Bun or the Effect
runtime (a `model.ts` may import the error taxonomy; the domain may not), so the promise above is
enforced rather than conventional.

## Running it

`bun run dev` serves on `127.0.0.1:4000`; the app runs `bun src/server.ts` from the checkout in
its `Info.plist`. See the README for the product-level description and
[`../decisions/linux-native-window.md`](../decisions/linux-native-window.md) for how the native
window is hosted.
