# Architecture

> **Kind:** guide · **Status:** active

IWE is one Bun process that serves an HTTP API and a React page, talks to the vendors' own CLIs
(`git`, `gh`, `az`, `jira`, `tmux`, `ttyd`), and keeps its only state in one directory per
change (`~/changes/<id>/`). Everything else is read live and cached in
[`src/cache.ts`](../../src/cache.ts).

## Layers

```
src/
  server.ts            Bun.serve: the core route table, /api/ext/:name/* dispatch, SSE, ttyd ws-proxy
  effect/              errors (taxonomy) · http→status mapping · runRoute · Workspace tag
  schemas/             Effect Schemas for change.json and config.json
  config.ts settings.ts  config file + settings page
  changes.ts complete.ts cancel.ts commit.ts local.ts summary.ts titles.ts …  core domain
  sh.ts cache.ts events.ts  subprocess gate, SWR cache, SSE hub + watcher
  terminal.ts terminalProxy.ts  tmux sessions, ttyd spawn, ws bridge
  integrations/        vendor CLI wrappers (git, github, azure, checks, stacks)
  extensions/          host + api.ts contract + built-ins (agents, git, ci, jira,
                       github-issues, deployments)
  web/                 React UI, bundled by Bun's HTML import, no framework
```

The extension host (`src/extensions/index.ts`) loads built-ins and out-of-tree modules through
the same install path and answers the core's one question — which extensions exist for this
workspace — with a filtered list. See [`extensions.md`](extensions.md) for the contract.

## Where a feature's code lives

The intended rule, so a feature is not a scavenger hunt across four directories:

- **`src/extensions/<name>/`** — the declaration, its wiring, and the feature's own
  implementation and client half.
- **`src/integrations/`** — vendor clients genuinely shared by more than one feature. `git.ts`
  qualifies (the core's `complete`/`cancel`/`commit`/`local`/`repos` all use it); a vendor
  client used by exactly one feature does not.
- **top-level `src/*.ts`** — core domain that is not a feature.

This rule is not yet fully applied. Deployments currently spans
`extensions/deployments/` + `src/deployments.ts` + `src/deploySettings.ts` +
`src/deployConventions.ts` + `src/integrations/azure.ts`; ci and git split similarly. Item 5 of
[`../plans/refactor-plan.md`](../plans/refactor-plan.md) moves them, deployments first.

## What stays core

What everything else stands on: tmux and ttyd session handling themselves (names, icons, status
are extensible), the git worktree engine, the change lifecycle (create, complete, cancel), and
the page shell. Everything else is a surface an extension can contribute to.

## Dependency rules

- **Extensions** import only from `src/extensions/api.ts`, which is the whole promise. The host
  provides the capabilities (`Shell`, `Cache`, `Settings`, `Bus`, `Workspace`) so an extension's
  requirements arrive through the Effect `R` channel.
- **The browser** (`src/web/**`) must not import backend modules that shell out or touch the
  filesystem; `eslint.config.js` enforces the boundary and `src/shared/` is where pure vocabulary
  both sides need belongs.
- **HTTP** is the only client/server boundary — no shared runtime state across it.

## Running it

`bun run dev` serves on `127.0.0.1:4000`; the app runs `bun src/server.ts` from the checkout in
its `Info.plist`. See the README for the product-level description and
[`../decisions/linux-native-window.md`](../decisions/linux-native-window.md) for how the native
window is hosted.
