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
  workspace/           the workspace module: server/ (config loader, file schema, workspace
                       resolution, repository browser), client/ (the switcher, WorkspaceCard,
                       RepoBrowser)
  settings/            the settings module: server/ (settings page read/write, legacySettings),
                       client/ (SettingsPage, SettingsFields)
  change/              the change module: model.ts, server/ (schema, store, create, complete,
                       cancel, commit, review, titles, description, leftovers, index.ts), client/ (the
                       page, the dialogs, the review surface), wizard/ (the New change wizard,
                       client/ + index.ts), overview/ (the dashboard: server/summary.ts composes
                       change, terminal and the host; client/ holds the cards)
  terminal/            the terminal module: server/ (tmux sessions, ttyd spawn, the ws bridge,
                       the presenter merge), client/ (the terminal pane, tabs, cheat sheet)
  core/
    domain/            the pure vocabulary: change.ts, widget.ts, terminal.ts, time.ts, config.ts
    platform/          the substrate everything stands on: effect/ (errors, http, run, tags),
                       capabilities/ (sh, cache, events), origin.ts, platform.ts, tooling.ts,
                       routes/ (the HTTP tables)
    integrations/      vendor CLI wrappers (git, github, azure, stacks)
    host/              the extension contract and its machinery: api.ts (and api/*.ts), registry.ts,
                       discover.ts, selectors.ts, effects.ts, dispatch.ts, services.ts,
                       clientChunks.ts, client.tsx (the page's client-side registry and the
                       extension UI contract), index.ts
  extensions/          the built-ins (agents, git, ci, jira, github-issues, deployments)
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

What everything else stands on: tmux and ttyd session handling themselves (names, icons, status
are extensible), the git worktree engine, the change lifecycle (create, complete, cancel), and
the page shell. Everything else is a surface an extension can contribute to.

## Dependency rules

- **Extensions** import only from `src/core/host/api.ts`, which is the whole promise. The host
  provides the capabilities (`Shell`, `Cache`, `Settings`, `Bus`, `Workspace`, `ExtensionStore`)
  so an extension's requirements arrive through the Effect `R` channel.
- **The browser halves** (`src/frontend/**`, a module's `client/**` and a submodule's) must not
  import backend modules that shell out or touch the filesystem; `eslint.config.js` enforces the
  boundary at each depth, `src/core/domain/**` is where pure vocabulary both sides need belongs,
  and `src/core/host/client.tsx` is the one browser file under `core/` a half may import by value.
  Everything under `src/core/platform/**` and `src/core/integrations/**` is server-only, like a
  module's `server/**` half.
- **HTTP** is the only client/server boundary — no shared runtime state across it.

## Running it

`bun run dev` serves on `127.0.0.1:4000`; the app runs `bun src/server.ts` from the checkout in
its `Info.plist`. See the README for the product-level description and
[`../decisions/linux-native-window.md`](../decisions/linux-native-window.md) for how the native
window is hosted.
