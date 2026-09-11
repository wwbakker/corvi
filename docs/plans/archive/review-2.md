# Architecture review — layout and structure

> **Kind:** review · **Status:** active

A review of the application's architecture and file layout: how the code is organised, where
the seams are, and what could be simplified. Details and behaviour are out of scope — this is
about the shape. Findings are ordered roughly by impact, and almost all of them are migration
residue rather than design mistakes: the load-bearing decisions are sound.

## The architecture as it stands

```
src/
  server.ts            one Bun.serve: core routes + /api/ext/:name/* dispatch + SSE + ttyd ws-proxy
  effect/              errors (5-tag taxonomy) · http→status mapping · runRoute · Workspace tag
  config.ts, settings.ts, schemas/    config file + settings page + Effect Schemas
  changes.ts, complete.ts, cancel.ts, commit.ts, local.ts, summary.ts, …   core domain
  sh.ts, cache.ts, events.ts           subprocess gate, SWR cache, SSE hub + watcher
  terminal.ts, terminalProxy.ts        tmux sessions + ttyd spawn + ws bridge
  integrations/                        vendor CLI wrappers (git, github, azure, checks, stacks)
  extensions/                          host + api.ts contract + 6 built-ins
                                       (agents, git, ci, jira, github-issues, deployments)
  web/                                 React UI, bundled by Bun's HTML import, no framework
```

What is working well, so it survives whatever follows:

- One error taxonomy (`../../../src/effect/errors.ts`) with a single HTTP mapping (`src/effect/http.ts`).
- An additive extension contract in one file (`../../../src/extensions/api.ts`) — cards, wizard steps,
  routes, pages, settings all contribute, nothing is a singleton slot.
- Capabilities (`Shell`, `Cache`, `Settings`, `Bus`, `Workspace`) provided per request through
  Effect layers; extension code depends on the R channel, not on ambient state.
- The SWR cache with its two honesty rules, and the single SSE hub that replaced per-page
  polling.
- The browser/backend boundary enforced by lint rather than convention.

The structural debt below is concentrated in the two recent migrations (the Effect rewrite and
the plugin-system migration), each of which moved part of the code and left the rest where it
was.

## Findings

### 1. A feature's code lives in up to three places

The plugin-system migration moved the *descriptions and routes* into `../../../src/extensions` but left
the *implementations* where they were. One feature is now a scavenger hunt across directories:

- **deployments** = `extensions/deployments/` (routes + page) + `src/deployments.ts`
  (implementation) + `../../../src/deploySettings.ts` (settings chain) + `src/deployConventions.ts`
  + `../../../src/integrations/azure.ts`
- **ci** = `extensions/ci/index.ts` + `integrations/github.ts` + `integrations/azure.ts`
  + `integrations/checks.ts`
- **git** = `extensions/git/index.ts` + `integrations/git.ts` (which `complete.ts`, `cancel.ts`,
  `commit.ts`, `local.ts` and `repos.ts` also share)

The layering rule — extensions describe, integrations implement — is implicit; you reverse-
engineer it from doc comments ("the implementation lives where it always has"). Either:

- **finish the move**: feature-specific implementations into their extension folder, keeping
  `integrations/` only for genuinely shared vendor-client helpers (`git.ts` is the one truly
  shared by the core), or
- **formalize the split** in `../..`: `extensions/` = contribution + wiring, `integrations/` =
  vendor clients, top-level `src/*.ts` = core domain.

The `deploy*.ts` trio at top level is the clearest candidate for the move: it serves exactly one
extension, and nothing else in the core reaches into it except `workspaces.ts`'s `azureOf` for
a legacy fallback.

### 2. The dual Effect/Promise API surface is mostly dead weight

Every migrated module exports both `readChangeEffect` and `readChange`, and so on, "kept for the
test suite". Counted callers today: `readChange`, `writeChange`, `listChanges`, `createChange`,
`archiveChange`, `provision`, `repoStatusOf`, `loadCache`, `saveCache`, `readNotes`,
`writeNotes`, `writeSidecar`, `shOrThrow` and `currentEnv` have **zero `../../../src` callers** — they
exist only for tests. `sh` and `swr` are the only facades the app itself still uses.

That dual surface is what keeps `src/context.ts`'s AsyncLocalStorage shim alive (Promise
facades cannot carry the `Workspace` tag), which in turn keeps a three-way fallback in
`currentWorkspaceEffect` (tag → ALS → undefined). A whole seam — the last piece of pre-Effect
ambient state — is sustained by test convenience, not by app need.

Simplification: migrate the Promise-shaped tests to the Effect APIs (or a small test helper that
provides the tag), then delete the facades and the ALS shim. Even a partial pass — deleting the
facades no `../../../src` code uses and porting only the tests that call them — would shrink the
exported surface of half the modules and make "the Effect API *is* the API" true.

### 3. Legacy settings resolution is scattered across four modules

The precedence chain for extension settings (extensionSettings bag → legacy flat field → env
var → vendor default) is implemented in four places: `deploySettings.ts`, `workspaces.ts`'s
`azureOf`, `config.ts`'s `load()`, and `migrateWorkspaceSettings()` — which lives in
`extensions/index.ts` and runs both after load and after every settings write. The legacy
folding (`workspace.jira`, `workspace.azure === false`) is migration scaffolding, but it is
spread so thin that retiring one legacy field later means touching four modules.

Either centralize legacy fallback and migration in one module (settings or config), or — cleaner
long term — declare a config version and drop the legacy reads entirely.

### 4. `extensions/index.ts` is four modules in one

597 lines doing: registry (`loaded` / `install`), per-workspace queries (`cardsFor`, `pagesFor`,
`titleSourcesFor`, … — five near-identical one-line `flatMap`s that want to be one generic
helper), route dispatcher and matcher, out-of-tree discovery, and the legacy settings migration
(finding 3). Splitting registry / dispatch / discovery apart would also let the
`extensions/presenters.ts` set-source indirection — a module-cycle avoidance currently explained
in a comment — become visible in the import graph instead.

### 5. Naming drift: "integration" vs "extension"

The concept was renamed; the vocabulary half followed. Routes still say
`/api/changes/:id/integrations`, route params say `:integration`, the wire field is
`Widget.integration`, the client type is `IntegrationInfo`, the host lookup is `cardByName`.
Renaming the wire field is a breaking change for out-of-tree extensions (documented in
`../../guides/extensions.md`), but the internal names could be aligned, and one note in the docs that
"integration" is the legacy spelling would save every future reader the confusion.

### 6. The web boundary is an allowlist instead of a place

`../../../eslint.config.js` enforces that `src/web/**` imports only `types.ts`, `branch.ts` and
`deployConventions.ts` from the backend — by exception list. Every new pure shared module means
a lint edit and a comment justifying it. A `src/shared/` directory for the pure vocabulary (no
CLI/fs imports, so the boundary becomes a *structural* rule) would retire the allowlist and
prevent it growing.

### 7. Repo-root clutter, and the `extensions/` name collision

- Root `extensions/agent-state.ts` is a **pi-side** extension, unrelated to `../../../src/extensions` —
  same word, different meaning, one directory apart. Renaming to `pi/` or `agent/` removes a
  genuinely confusing collision.
- `review-findings-plugin-system-3.md`, `review-fixes-report.md` and
  `effect-migration-sh-context.md` at the root are migration artifacts. Move to `docs/history/`
  (or fold their still-true content into `../../guides/effect-conventions.md`, which already covers most
  of it) and delete.
- `../../../README.md` is 84KB — it has grown into the full manual. The reference material (settings
  reference, environment variables, extensions, Linux notes) could live in `docs/`, leaving an
  overview and quickstart.

### 8. Smaller things

- `server.ts` (652 lines) is still readable as one route table, but it mixes bootstrap (cache
  restore, client-chunk build, the page-build check), helpers (`withChange`, `bodyOf`,
  `attempt`) and ~40 routes; `messageOf` is duplicated between `server.ts` and
  `extensions/index.ts`. If it grows, grouping routes into `src/routes/*.ts` is the natural
  split. Not urgent.
- `ChangeView.tsx` (773 lines), `SettingsPage.tsx` (626) and the 2,030-line `styles.css` are the
  web-side monoliths; each is at the size where extracting sub-components and sections starts
  paying for itself.
- Mixed `Bun.file` / `Bun.write` and `node:fs` / `node:fs/promises` usage across modules —
  cosmetic, but one convention would be nice.
- `applyPatch` throws typed errors from sync code, caught at the boundary via `attempt()` —
  documented and consistent, but it is a second error path beside the E channel; worth watching
  so it does not spread.

## If only two things get done

The best simplification-to-risk ratio:

1. **Finish colocating feature implementations with their extensions** — deployments first, it
   has zero shared consumers.
2. **Retire the Promise facades and the ALS shim** by porting the Promise-shaped tests.

Both are mechanical, and both remove whole categories — scavenger-hunt navigation and the
ambient-state seam — rather than shuffling code between shelves.
