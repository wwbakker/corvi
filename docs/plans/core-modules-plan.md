# Core modules and the extension contract

> **Kind:** plan · **Status:** active

> **Supersedes** [`archive/extensions-migration-plan.md`](archive/extensions-migration-plan.md),
> whose work packages are implemented: the overview summary, cancelling's loose ends, terminal
> presentation, the deployments page and the extension-declared settings all live behind the
> surfaces in [`guides/extensions.md`](../guides/extensions.md). Its closing review is this
> plan's last slice.

The goal is a small core that owns only invariants, modules with one scannable public face, and
an extension contract small enough that a reader can tell where a new contribution attaches
without reading implementations. This plan settles the module map and the remaining contract
decisions first, then moves code slice by slice.

Every slice ends at the baseline in [Verification](#verification) and updates the `src/…` links
in `docs/` in the same change; this repository's documentation cites paths, so a move that leaves
them stale is not done.

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
  data the server sends.
- **Terminal presentation is extensible; tmux and ttyd themselves are core furniture.**
- **The git worktree engine is core.** Extensions act on changes; they do not create them.

Deliberately not core: tmux/ttyd internals, the git engine, and any native functionality. The
native hosts provide capabilities (`notify`, dialogs, external links, window lifecycle) and
extensions consume them; no module ships per-platform code. A client-side `Host` capability would
follow the server's `Shell`/`Workspace` pattern exactly, but building it is not in this plan.

## The target tree

A module is one directory with three aspects — its server half, its client half, and the pure
model both may import — and the wiring stays separate, exactly as a built-in extension is
`index.ts` + `client.tsx` today. What belongs to the browser as a whole (the router, the sidebar,
the data hooks, the HTTP client) lives in `frontend/`, not scattered per domain.

```
src/
  core/
    domain/               the ubiquitous language, pure; imports nothing that runs
      change.ts           Change, states, ordering, branchFor, CompletionStep/Progress
      widget.ts           Widget, WidgetItem, WidgetState, worst, SummaryFact
      terminal.ts         the presented-window vocabulary
      time.ts             pure presentation helpers the vocabulary implies (`ago`)
    platform/             the substrate everything stands on
      effect/             errors, http, run, support, tags
      capabilities/       sh, cache, events — the live layers behind Shell, Cache, Bus
      origin.ts           the request guard
      platform.ts         platform detection, host environment
      tooling.ts          what CLI tools exist on this machine
      routes/             the HTTP tables, per domain
    host/                 the extension contract and its machinery
      api/                the contract, one file per surface group; api.ts re-exports
      registry.ts discover.ts selectors.ts effects.ts dispatch.ts clientChunks.ts
      client.tsx          the page's client-side registry and extension UI contract
    change/
      model.ts            pure change logic the halves share
      server/             store, create, complete, cancel, commit, review, titles, description,
                          leftovers
      client/             the change page, the dialogs, the review surface
      wizard/             a submodule: the New change wizard
      overview/           a submodule: the dashboard, composing change, terminal and the host
    terminal/
      server/             tmux, proxy, presenter (merge + defaults)
      client/             TerminalPane, WindowTabs, CheatSheet, key hints
      model.ts
    workspace/
      server/             config, workspaces, repos
      client/             the switcher, WorkspaceCard, RepoBrowser
      model.ts
    settings/
      server/             settings, legacySettings
      client/             SettingsPage, SettingsFields
      model.ts
    frontend/             the browser shell and runtime: index.html, styles, app/router, Sidebar,
                          data hooks, fetch client, notifications
    integrations/         vendor clients shared by core and built-ins (git, github, azure)
  extensions/             the extensions, and nothing else
    agents/ ci/ deployments/ git/ github-issues/ jira/
  server.ts               composes the route tables and starts Bun
```

Three placements deserve their reasons:

- **`change/wizard/` and `change/overview/` are submodules.** A submodule is a module: its own
aspects, its own `index.ts`, the same rules; the convention nests as far as a feature needs.
The dashboard composes the change, its terminals and every contributed card; as a sibling of
`change/server` it would make `change` and `terminal` import each other. Composition lives in the
submodule that composes, and the dependency graph has no cycles at any level.
- **`terminal/` knows sessions, not changes.** It receives the change directory from its caller
rather than asking the change module for it, which is what lets `change/overview/` depend on the
terminal without closing a cycle. The general rule: when two modules seem to need each other, one
side takes plain data (an id, a directory) instead of resolving it through the other.
- **`integrations/` lives under `core/`.** It is a shared vendor layer; built-in extensions keep
importing it under the first-party privilege below. Two of its files are extension-only and move
into `extensions/deployments/` when `azure: false` folds into per-workspace enablement
(`azure.ts`, `deploySettings.ts`); that fold is a follow-up decision, not a slice here.

Module directories are singular and named for their domain. A file is named for its one role;
inside a module, sibling imports are direct and only code outside the module enters through
`index.ts`.

## Dependency rules

- **`domain/**` imports nothing that runs** — types, states, pure operations; no `node:*`, no
  `Bun.*`, no Effect runtime. It is the ubiquitous language every module and the contract speak.
- **A module's `model.ts`** may import `domain/**` and is pure for the same reason.
- **`server/`** may import its own module, `domain`, `platform`, `integrations` and the host's
  server machinery. It must not import a `client/` file or anything under `frontend/`.
- **`client/`** may import its own module, `domain`, `frontend` and the host's client contract. It
  must not import a `server/` file.
- **`frontend/`** may import `domain` and module clients; never module servers. It is the
  browser's composition root, the counterpart of the extension host.
- **Submodules are modules.** `change/wizard/` and `change/overview/` follow the same rules and
  have their own `index.ts`. Composition lives in the submodule that composes; the overview
  depends on `terminal` and the host, and no cycle forms at any level.
- **The contract** (`host/api`) imports `domain` and the capability and error leaves it
  re-exports (`Shell`, `Workspace`, the taxonomy, `Result`); never a module's server or client
  half. So the contract cannot change when a module is reshaped — it re-exports the promised
  slice of the domain (`Change`, `branchFor`, the widget vocabulary).
- **Modules use each other's `index.ts`, never each other's halves.** No cycles: where two
  modules seem to need each other, one side takes plain data (an id, a directory) or the
  composition moves up into `overview`/`page`.
- **Built-ins are first-party** and may import core modules and `integrations/` today. The target
  is narrower: new built-in code uses `host/api` + `domain` + `integrations/`, so the privilege
  shrinks by default, and the portability proof in the last slice keeps it honest. Out-of-tree
  extensions never get the privilege; there is still no stability promise for them (see
  [Contract decisions](#contract-decisions-this-plan-implements)).
- `server.ts` is the composition root for HTTP; it imports `platform/routes` and the host.

The ESLint boundary changes shape rather than strength. Today it says "`src/web/**` may not
import a backend module"; afterwards there are two rules: a client half or `frontend/` may not import
any `server/**` file, and `domain`/`model` files may not import anything that runs (`node:*`,
`Bun.*`, the Effect runtime). Both are structural, so a new module inherits them by existing.

## Module internals: the interface is what you read first

A module is `server/` + `client/` + `model.ts`, any of which may be absent: a headless module has
no client half, a vocabulary module no server. The aspects sit in the same directory, so a
feature's server, browser and shared code travel together, as an extension's already do. The
wiring — route tables, the client registry, chunk building, the page shell — lives in `platform`, `host` and `frontend`, never inside a module.

Within the server half:

- **`store.ts`** — the module's persisted state: read, write, list, archive. Effects with typed
  errors.
- **operation files** — one per operation (`create.ts`, `complete.ts`, `cancel.ts`), orchestrating
  the store, the integrations and the contributed steps.
- **`index.ts`** — the module's public face, re-exporting model and server surface. Siblings
  import each other directly; nothing inside the module imports the barrel, which is what keeps
  barrels cycle-free.

The public surface is checked by the compiler, not mirrored by hand: `bun run outline
src/core/change` prints the module's exports with full types and doc summaries, bodies elided.
An Effect signature already names the error and requirement channels (`Effect<A, E, R>`), so the
outline is normally enough to work against a module; the implementation is opened when it is
changed. The reading rule is documented where it is useful, not duplicated into per-module
inventories.

## Contract decisions this plan implements

### The domain is the ubiquitous language

`src/types.ts` and `src/terminalTypes.ts` become `src/core/domain/` (`change.ts`, `widget.ts`,
`terminal.ts`). The domain holds the vocabulary more than one module speaks — the `Change` DTO,
its state machine, the `Widget` vocabulary, the presented-window shape — plus the pure operations
on it (`isFinished`, `byWorkOrder`, `branchFor`), and nothing else. `host/api` re-exports the
promised slice of it, so the contract is typed by the domain rather than by a module's internals;
module-specific pure logic stays in that module's `model.ts`.

`src/shared/` disappears as a name — it was defined by *who imports it*, which is why it read as a
grab-bag (a change-domain helper, a deployments convention, a time formatter). With modules
owning their halves, each file finds an owner: `branchFor` joins the change domain,
`deployConventions` joins the deployments extension, and `ago` is pure presentation vocabulary
(a widget row's `at`), so it joins the domain as `domain/time.ts`. The ESLint filename exception
for `types.ts` goes away.

### Before/after lifecycle events

Every lifecycle moment comes in a pair, and the pair is the pattern:

| Moment | Before (may transform, may veto) | After (observer, never fails the operation) |
|---|---|---|
| Create | `change:creating` | `change:created` |
| Complete | `change:completing` | `change:completed` |
| Cancel | `change:cancelling` | `change:cancelled` |

- A **before** hook runs before the core commits the operation. It receives the plain draft and
  returns a patch (`ChangeDraft` → `Partial<ChangeDraft>`) or nothing; hooks run in extension
  load order and **chain**: each sees the patch of the one before it. The core applies the result
  and then re-runs every invariant (id shape, repos non-empty, valid state transitions): an
  extension may suggest, never bypass. Failing with the taxonomy vetoes the operation, and the
  message is shown where the operation was started.
- An **after** hook runs once the core has committed. It receives the final `Change`, returns
  nothing that matters, and can never fail the operation: a failure is reported under the
  extension's name, the way provisioning is reported today.
- The distinction answers where a side effect belongs: **before** hooks decide what the change
  *is* (its id, branch, repositories, metadata), **after** hooks act on a change that exists
  (assign the ticket, label the pull request). An after-hook that fails does not fail the change.
- **Planned steps stay separate.** Completion's contributed steps are inside the operation —
  planned once, named in the journal before anything runs, ordered, and able to stop it. They are
  not reachable through the events map; there are not two ways to hang work off a completion with
  different failure semantics. Cancellation gets a planned-step list only when a second consumer
  needs one; the journal machinery is shared so that is a reuse, not a copy.
- Enablement is resolved per workspace at the moment of the event, like every other surface.

### `ExtensionStore`: one writer, namespaced files

The core is the single writer of `change.json`. An extension that needs to remember something
gets a capability instead of the file:

```
class ExtensionStore extends Context.Tag("iwe/ExtensionStore")<ExtensionStore, {
  /** Replace this extension's own entry in the change's `extensions` bag, writing once. */
  update(change: Change, data: unknown): Effect.Effect<Change, …>;
  /** The extension's own directory inside the change: `extensions/<name>/`, created on demand.
   * Entries travel into the archive with the change; paths are confined to it. */
  read(change: Change, path: string): Effect.Effect<string, …>;
  write(change: Change, path: string, text: string): Effect.Effect<void, …>;
  list(change: Change): Effect.Effect<string[], …>;
}>() {}
```

The host provides the layer **per contribution with the extension's name bound**, so an effect
writes `notes.md` and lands in `extensions/<extension>/notes.md` without naming itself. The
capability exists wherever a committed change exists (after-hooks, planned steps, cards, routes);
a `change:creating` hook has no directory yet, so a creator that needs files writes them in
`change:created`. `change.json`, `wt.toml` and the core's own sidecars are not reachable through
it.

### The api is split, the promise is not

`core/host/api/` gains one file per surface group, mirroring the guide's table:
`capabilities.ts`, `cards.ts`, `wizard.ts`, `lifecycle.ts`, `overview.ts` (summary, loose ends,
description), `terminal.ts` (presenters), `pages.ts`, `settings.ts`, `routes.ts`. `api.ts`
re-exports them and stays the one import an extension needs — the split makes the contract
navigable, not smaller, and changes nothing for a consumer.

### Stability and first-party privilege

There is no stability promise for out-of-tree extensions yet, and this plan does not add one.
What it does add is a narrower default: the contract is `host/api` plus `domain/`, built-ins may
still reach into core while they are first-party, and the portability proof in the last slice
keeps that privilege from being taken for granted. When third-party extensions become a real
audience, the narrowness is the thing to build the promise on — not a new API.

## Slices

Each slice is a pull-request-sized change that ends at the baseline. Only S1 changes behaviour.

### S0 — the domain and the contract's home

Move `types.ts`/`terminalTypes.ts` into `core/domain/`; give `shared/`'s files owners
(`branchFor` → `domain/change.ts`, `ago` → `domain/time.ts`, `deployConventions` →
`extensions/deployments/`); move `api.ts` and the host machinery into `core/host/`, splitting
`api.ts` into `api/*.ts` re-exported from `api.ts`. Built-ins update their imports;
`src/extensions/` then contains extensions only. Mechanical: no behaviour change, but the ESLint
boundary is rewritten for the shape the later slices land in (`server/` versus `client/` and
`frontend/`, pure `domain`/`model`). One commit per move if the diff reads better that way; the slice
is done when the tree matches and the guides' paths are updated.

### S1 — lifecycle events and `ExtensionStore`

Add the event names and semantics above; convert the existing `change:created` declarations;
provide `ExtensionStore` with the per-extension layer and the namespaced directory; make `applyPatch`
and `createChange` re-validate after a transform. Tests: chained transform order, veto by
failure, after-hook failure reported not fatal, `change.json` unreachable, files land under the
extension's directory and survive `archiveChange`. Update the extension guide.

### S2 — the change module

Move `changes.ts`, `complete.ts`, `cancel.ts`, `commit.ts`, `local.ts`, `titles.ts`,
`description.ts` and `leftovers.ts` into `change/server/` (splitting `changes.ts` into
`store.ts`/`create.ts` where the roles are already clear), with `change/model.ts` for its pure
logic and `index.ts` as its face; move the change surfaces of `web/**` (`ChangeView`, the
dialogs, `changeState`) into `change/client/`. The wizard and the dashboard cards follow in S5
as submodules. Mechanical: behaviour and tests are
unchanged apart from import paths. This is the largest token win and the worked example for the
per-module layout.

### S3 — the terminal module

Move `terminal.ts` and `terminalProxy.ts` into `terminal/server/` as `tmux.ts` and `proxy.ts`,
extract the presenter merge and defaults into `presenter.ts`, and move `TerminalPane`,
`WindowTabs`, `CheatSheet` and the key hints into `terminal/client/`. Mechanical; the page keeps
rendering the presented shape.

### S4 — the workspace and settings modules

Move `config.ts`, `workspaces.ts` and `repos.ts` into `workspace/server/` with the switcher,
`WorkspaceCard` and `RepoBrowser` in `workspace/client/`; move `settings.ts` and
`legacySettings.ts` into `settings/server/` with `SettingsPage` and `SettingsFields` in
`settings/client/`. Mechanical.

### S5 — the wizard, the overview and the frontend

Move the wizard into `change/wizard/` and the dashboard composition into `change/overview/`
(`summaryOf` plus the cards), so both are submodules of the change they belong to. Move what
remains of `web/**` into `frontend/`:
`index.html`, the styles, `app.tsx` and the router, `Sidebar`, the data hooks (`state.ts`,
`cache.ts`, `events.ts`, `api.ts`), `notify.tsx`, `prefs.ts`, `moment.ts`, `poll.ts` and the
icons. `src/web/` is gone after this slice.

### S6 — the platform

Move `sh.ts`, `cache.ts` and `events.ts` into `platform/capabilities/`, `origin.ts`,
`platform.ts` and `tooling.ts` beside them under `platform/`, `effect/` into `platform/effect/`,
`routes/` into `platform/routes/`, and `integrations/` under `core/`. Mechanical.

### S7 — docs, proof, review

Update the durable guides: `architecture.md` to the module map and dependency rules,
`extensions.md` to the event and `ExtensionStore` contract, `style.md` to the module internals and
the outline rule. Add the portability proof: load a real built-in through the out-of-tree path in
a test, so "could this extension live outside the repository?" has an answer that runs. Then a
fresh reviewer walks the whole diff against this plan and the conventions; findings are fixed
before the plan is deleted, its durable parts having been extracted into the guides.

## Verification

Every slice ends with

```sh
bun run typecheck && bun run lint && bun run test
```

with **no new failures**. The recorded baseline (the archived migration plan, and the state the
first slice starts from) is everything passing except the Playwright-driven tests, which are
environment-bound on this machine: `test/webkit.test.ts` cannot launch WebKit at all, and the
Chromium-based page tests fail or skip when the shared `~/.cache/ms-playwright` holds a browser
revision other than the one this checkout's Playwright expects — a sibling worktree's
`playwright install` does exactly that. A failure is acceptable at the end of a slice only when
it is one of those, and the slice says so. `bun run outline` is not a test, but a moved module
whose outline is unreadable is a slice that is not done.

## Open questions, to settle during the slice that needs them

- **The wizard's server half.** The plan gives `change/wizard/` a client half only; if listing its
  steps ever needs logic beyond the host selectors, it gains a `server/` like any module.
- **`ExtensionStore` shape.** `update` could take the whole bag (`Record<string, unknown>`) or
  only this extension's value. The plan assumes the latter, because the capability is provided
  per extension.
- **A client `Host` capability** for notifications and navigation: it is a capability, implemented
  by `frontend` and the native bridges, not a module; it follows the server capability pattern
  when it lands.
