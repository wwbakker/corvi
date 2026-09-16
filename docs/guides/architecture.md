# Architecture

> **Kind:** guide · **Status:** active

Corvi is one server process — Electron's Node in the app and in development (`bun run dev` starts
it with `node --watch`; [`../decisions/node-server.md`](../decisions/node-server.md),
[`../decisions/node-pty-terminal.md`](../decisions/node-pty-terminal.md)) — that serves an HTTP
API and a
React page, talks to the vendors' own CLIs (`git`, `gh`, `az`, `jira`, `tmux`), and keeps
its only state in one directory per change (`~/corvi/changes/<id>/`). Everything else is read live and
cached in [`src/capabilities/cache.ts`](../../src/capabilities/cache.ts).

## Layers

```
src/
  server.ts            node:http: composes the modules' route tables, /api/ext/:name/* dispatch,
                       SSE, the terminal socket
  change/              the change module: model.ts (the edit rule the halves share), server/
                       (schema, store, create, start, complete, cancel, titles, description,
                       plan, index.ts), routes.ts (its HTTP table). No UI.
  dashboard/           the dashboard tab: server/ (summary.ts composes change, terminal and the
                       host; index.ts is the face), client/ (WidgetCard, WidgetRows,
                       PerRepoCard, CompletionCard, EditReposDialog), routes.ts (the summary route)
  change-page/         the change shell: client/ (ChangeView, changeTabs, PlanCard,
                       CancelDialog, CompleteAnywayDialog, refusals) composes the dashboard,
                       the extension tabs and the terminal; owns no data
  wizard/              /new: Wizard.tsx, and index.ts (the face)
  terminals/           the terminal module: model.ts (the new-window key and the CSI-u sequences
                       page and server share), server/ (tmux sessions and windows, the pty and
                       its socket bridge, the presenter merge), client/ (the terminal pane,
                       tabs, cheat sheet), routes.ts (the terminal socket and the window API)
  workspace/           the workspace module: model.ts (Entry, the repository-browser row),
                       server/ (config loader, file schema, workspace resolution, repository
                       browser), client/ (the switcher, WorkspaceCard, RepoBrowser),
                       routes.ts (the repo browser and the workspaces list)
  settings/            the settings module: model.ts (Settings, SettingsView), server/ (settings
                       page read/write, legacySettings), client/ (SettingsPage, SettingsFields),
                       routes.ts (the settings file route)
  domain/              the pure vocabulary: change.ts, widget.ts, terminal.ts, time.ts, config.ts
                       (Workspace and the resolved Config as well as the ConfigFile shape),
                       settings.ts (the extension-declared setting shapes), host.ts, chrome.ts
  capabilities/        the substrate everything stands on: effect/ (errors, http, run, support,
                       tags), serve.ts (the node:http route server), files.ts (file reads and
                       writes), identity.ts (the product name, the CORVI_ environment prefix and
                       the path defaults), shell.ts, cache.ts, bus.ts (the SSE hub, the watcher
                       and the stream's routes), web.ts, os.ts
  extension-host/      the extension contract and its machinery: api.ts (and api/*.ts),
                       registry.ts, discover.ts, selectors.ts, effects.ts, dispatch.ts,
                       services.ts, clientChunks.ts, vendor-jsx.ts, client.tsx (the page's
                       client-side registry and the extension UI contract), migrate.ts, index.ts,
                       routes.ts (wizard, pages, ext dispatch, card/tab endpoints, extension
                       client and vendor chunks)
  vendors/             vendor CLI wrappers (git, github, stacks)
  extensions/          the built-ins (agents, git, github, jira, github-issues, azure-devops,
                       leftovers, review, notes)
  app-root/            the browser shell and runtime, bundled by esbuild from client.ts (the
                       dev watcher and the production build): index.html, styles.css, app.tsx
                       (the shell, changes list, URL↔view), state.ts, prefs.ts, poll.ts,
                       events.ts, api.ts, cache.ts, Sidebar.tsx, ChangeCard.tsx, ActionsMenu.tsx,
                       icons.tsx and icons/, moment.ts, stateClass.ts, Progress.tsx,
                       LifecycleFailures.tsx, notify.tsx, host.ts, contextMenu.ts, routes.ts
                       (the icons and the /* fallback)
```

The rest of the tree:

```
pi/agent-state.ts           pi extension: publishes working/waiting to tmux
scripts/app.ts              installs the app: macOS .app, or Linux entry + launcher
scripts/app/electron/       the window: main.ts and preload.ts, built into main.cjs by build.ts
scripts/app/mac.ts linux.ts the platform installs
scripts/app/run.ts drive.ts app:run (from the checkout) and app:drive (Playwright)
scripts/clean-test.ts       ends what a test run left behind, by ownership
test/                       the suite; test/terminal.test.ts drives a real pty and tmux
```

`scripts/migrate-from-iwe.ts` is the one-time move from the old names; it goes away once installs
have moved.

The extension host (`src/extension-host/index.ts`) loads built-ins and out-of-tree modules through
the same install path and answers the core's one question — which extensions exist for this
workspace — with a filtered list. See [`extensions.md`](extensions.md) for the contract.

## Where a feature's code lives

The rule, applied in `azure-devops` and `github`, so a feature is not a scavenger hunt across four
directories:

- **`src/extensions/<name>/`** — the declaration, its wiring, and the feature's own
  implementation and client half. `azure-devops/server.ts`, `azure-devops/pipelines.ts` and
  `github/checks.ts` are colocated this way, and so are `review/server.ts` (the git surface)
  and its `client.tsx`, and `notes/server.ts` (the `ExtensionStore` surface) and its `client.tsx`.
- **`src/vendors/`** — vendor clients genuinely shared by more than one feature: `github.ts`
  (the core's `complete`/`description` + the github and azure-devops extensions) and `git.ts`
  (the core + the git extension).
- **`src/capabilities/`** — the substrate, not a feature: the Effect runtime
  plumbing and the capabilities (`shell`, `cache`, `bus`, `web`, `os`) every module runs on.
- **top-level `src/*.ts`** — `server.ts`, the composition root.

A feature's pure vocabulary and its settings live with it: `azure-devops/deployConventions.ts`
is needed by both that extension's server and browser halves, and
`azure-devops/deploySettings.ts` is the extension's own read of the settings it declares, so
both sit beside them. The extension's `azure.ts` holds the organisation-and-project chain
(`azureOf`); its `pipelines.ts` holds the per-change pipeline facts (`pipelineItems`,
`activeRuns`).

`src/workspace/server/workspaces.ts` names no vendor — it only answers `extensionEnabled`,
the generic enablement every surface uses.

Git cannot be colocated while `src/vendors/git.ts` is shared by the core and the git
extension. Item 5 of [`../plans/archive/refactor-plan.md`](../plans/archive/refactor-plan.md) records this
scope. `src/vendors/github.ts` stays shared for the same reason: the core's `complete` and
`description` read the pull request through it, and the github and azure-devops extensions
read their halves through the contract's `Changes` capability.

## What stays core

A thing is core only if it meets at least one of these:

1. **It owns persisted state or an external session.** The `change.json` and `config.json`
   schemas, archive semantics, the change directory, tmux sessions and the ptys attached to them.
2. **It defines vocabulary that crosses a boundary** — server↔browser or core↔extensions. The
   `Change` DTO, `Widget`/`SummaryFact`, completion steps, the error taxonomy.
3. **It is a trust or capability boundary.** `Shell`, `Workspace`, `ExtensionStore`, the origin
   guard, HTTP/SSE.
4. **It is the composition root** — it decides when contributions run and merges them: the
   dashboard, the wizard shell, the completion journal, the sidebar shell, the extension host.

The consequences are worth stating because they settle arguments:

- The change **dashboard is core even though every card on it is an extension**: it composes and
  merges — the server-drawn cards and the client-drawn widgets alike. "Review changes" moved
  behind the change-tab contract precisely because it is a bounded git surface, not a
  composition; notes moved behind the dashboard-widget contract precisely because a textarea's
  client state is not a server-drawn card.
- The **sidebar is core as a shell**; its entries (workspaces, changes, pages, windows) are
  data the server sends. The **change page is core as a shell** too: it composes the core's
  Dashboard with the change tabs its workspace's extensions contribute — the review extension's
  "Review changes" among them — and resolves a tab id nobody offers back to the dashboard.
- **Terminal presentation is extensible; tmux itself, and the pty that attaches it, are core
  furniture.**
- The **git worktree engine is core.** Extensions act on changes; they do not create them.

Deliberately not core: tmux internals, node-pty, the git engine, and any native functionality. The
native hosts provide capabilities (`notify`, dialogs, external links, window lifecycle), which
extensions consume; no module ships per-platform code. A client-side `Host` capability would
follow the server's `Shell`/`Workspace` pattern when it lands.

## Dependency rules

- **`domain/**` imports nothing that runs** — types, states, pure operations; no `node:*`,
  no `Bun.*`, no Effect runtime. It is the ubiquitous language every module and the contract
  speak.
- **A module's `model.ts`** is the synchronous logic its halves share. It may import
  `domain/**` and the error taxonomy's data types; it performs no effects.
- **`capabilities/`** imports `domain`, plus three documented upward edges that predate this
  layout: `web.ts` (the `withChange` glue reads the change store and workspace resolution;
  its `Bridge` type import from `terminals/server/proxy.ts` is type-only and likewise
  carried over) and `bus.ts` (the watcher reads changes, windows and the notification
  setting). Injecting the watcher's sources is a named follow-up, not done here.
- **`vendors/`** imports `domain` and `capabilities`, plus one carried-over
  exception: `git.ts` (the worktree engine) reads the change store leaves and the workspace
  config. That is why git cannot be colocated (see [../plans/archive/refactor-plan.md](../plans/archive/refactor-plan.md)
  item 5). `github.ts` additionally reads the contract's `Changes` capability for the checkout
  lookup, so the github and azure-devops extensions reach the worktree without importing the
  store.
- **`extension-host/`** imports `domain`, `capabilities` and the documented first-party leaves
  (the change store, `vendors/git`, the workspace config, the settings precedence chain).
- **A feature module** (`change`, `dashboard`, `change-page`, `wizard`, `terminals`,
  `workspace`, `settings`) keeps its aspects together: `model.ts` is the pure logic both halves
  share, `server/` the implementation, `client/` the browser half when there is one, and
  `routes.ts` the HTTP table the composition root mounts. Its **server half** may import its own
  module, `domain`, `capabilities`, `vendors` and the host's server machinery; it must not import
  a `client/` file or `app-root/`'s browser code. Its **client half** may import its own module,
  `domain`, `app-root` and the host's client contract; it must not import a `server/` file by
  value. Cross-feature client→client imports (ChangeView composing the dashboard and terminal
  cards) are composition, not a boundary violation.
- **`app-root/`** is the browser's composition root and the counterpart of the extension host:
  it imports `domain`, feature client halves and the host's client contract, never a module's
  server file by value. Its `routes.ts` is the module's own server half — the icons route and the
  `/*` fallback that returns `app-root/index.html` — which is why that one file sits beside the
  browser code rather than in a `server/` directory.
- **Modules enter each other through the server half's `index.ts`** (`change/server/index.ts`,
  `terminals/server/index.ts` and `dashboard/server/index.ts`),
  never through a server file. Siblings import each other directly, and nothing inside a module
  imports its own barrel, which is what keeps barrels cycle-free. A module whose face is a
  browser component re-exports it from a top-level `index.ts` (`wizard/index.ts`); client
  components are otherwise imported file-to-file, since a barrel of components would pull every
  one into the page bundle. The deliberate exceptions are leaves a second module needs by value,
  and their reasons are three, not one: `extension-host/registry.ts` and `change/server/store.ts`
  break cycles by depending on state rather than on a half; `terminals/server/session.ts` is the
  terminal's socket boundary, imported directly by the files that speak the socket so the barrel
  does not drag node-pty into every server consumer; and
  `settings/server/legacySettings.ts` is the one statement of the settings precedence chain,
  shared by the workspace config loader and the azure-devops extension's settings read (see
  [style.md](style.md), rule 7).
- **Composition lives in the module that composes.** `dashboard` depends on `terminals` and the
  host, so `change/server` does not have to, and no cycle forms.
- **The contract (`extension-host/api`) imports `domain` and the capability and error leaves it
  re-exports** (`Shell`, `Workspace`, the taxonomy, `Result`) — never a module's server or client
  half. The contract therefore does not change when a module is reshaped; it re-exports the
  promised slice of the domain (`Change`, `branchFor`, the widget vocabulary).
- **Out-of-tree extensions import only `extension-host/api`**, which is the whole promise. **Built-ins
  are first-party** and may reach into core modules and `vendors` today; new built-in
  code uses the contract plus `domain` (and `vendors` when it needs a shared
  vendor client), so the privilege shrinks by default. The documented first-party exceptions are
  the leftovers page's read of the changes root, the azure-devops settings' read of the config
  file for its legacy fallback, and the jira legacy shim's read of
  `settings/server/legacySettings.ts` (see [extensions.md](extensions.md), "Scope, honestly
  stated"). There is no stability promise for out-of-tree extensions yet. The github and
  azure-devops extensions already run their `az`/`gh` calls through the contract's `Shell`,
  `Cache`, `Settings` and `Changes` capabilities.
- **`server.ts`** is the HTTP composition root: it imports the modules' route tables, the host
  and the capabilities bootstrap (cache, client chunks). **HTTP** is the only client/server
  boundary — no shared runtime state crosses it.

`eslint.config.js` makes the browser-facing and purity rules structural: a client half,
`app-root/` or the wizard's module-root browser half may not import a server file by value, and a
module inherits the boundary by existing. `domain/**` and every `model.ts` may not import
`node:*`, Bun or the Effect runtime (a `model.ts` may import the error taxonomy; the domain may
not), so the promise above is enforced rather than conventional.

## Running it

`bun run dev` serves on `127.0.0.1:4000`; the app runs `src/server.ts` on Electron's Node, from
the checkout recorded in its bundle (`corviRoot` in the app's `package.json`). See
[`../manual/install.md`](../manual/install.md) for the product-level description and
[`../decisions/electron-host.md`](../decisions/electron-host.md)
for how the window is hosted.
