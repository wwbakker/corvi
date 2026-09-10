# Refactor plan

> **Kind:** plan · **Status:** active

A single prioritized list built from `docs/plans/review-1.md` (my review) and
`docs/plans/review-2.md` (the other agent's). Both are kept as written; this file only
decides *what to do, in what order, and how to tell it is done*.

Ranking is by (value ÷ risk) ÷ effort, not by how interesting the change is. Every
item below is behaviour-preserving unless it says otherwise; the two that are not
behaviour-preserving are flagged as decisions, not tasks.

## Progress

| Item | State | Notes |
|---|---|---|
| 1. Shared CLI helpers | done | `src/effect/support.ts`; the 8 `shSoft`, 6 `cliJson`/`ghJson`, 6 `messageOf` and 4 `fs` copies are gone, and the two `worst` re-implementations point at `types.ts` |
| 3. `src/shared/` | done | `branch.ts` and `deployConventions.ts` moved; eslint boundary is now the structural `../shared/*` (`types.ts` stays a filename exception, documented in the config) |
| 7. Split `server.ts` | done | `server.ts` 652 → 83 lines; `src/routes/{helpers,changes,terminals,repos,settings,extensions,events,assets}.ts` |
| 8. Naming/root clutter | partial | the pi extension dir moved `extensions/` → `pi/`; the integration-vs-extension naming alignment is still pending |
| 9. Web monoliths | done | `ChangeView.tsx` 773 → 409, `SettingsPage.tsx` 626 → 293; extracted `WidgetRows`, `WidgetCard`, `PerRepoCard`, `WindowTabs`, `SettingsFields`, `WorkspaceCard` |
| 4. Legacy settings chain | done | one `src/legacySettings.ts` resolves the bag → legacy field → env → default chain and owns the migration |
| 2, 5, 6 | pending | next waves |

One test was hardened along the way: `test/terminal.test.ts`'s "a window that starts waiting is announced"
depended on a wall-clock race (the watcher had to observe the window in a non-waiting state before the
flip). It now waits for the server's own `/api/terminals` read instead. This was flaky before the
refactor and is deterministic now.

## The list

| # | Item | Sources | Value | Risk | Effort |
|---|---|---|---|---|---|
| 1 | Extract the duplicated CLI helpers | R1 §1 | high | very low | S |
| 2 | Retire dead Promise facades + the ALS shim | R2 §2 | high | low | M |
| 3 | `src/shared/` for the browser/server boundary | R2 §6 | medium | low | S |
| 4 | Centralize the legacy settings precedence chain | R2 §3 | medium | low | M |
| 5 | Colocate a feature's implementation with its extension (deployments first) | R1 §5, R2 §1 | high | medium | M |
| 6 | Split `extensions/index.ts` (registry / discovery / dispatch) | R1 §3, R2 §4 | medium | low | M |
| 7 | Split `server.ts` into `src/routes/*.ts` | R1 §4, R2 §8 | medium | low | M |
| 8 | Naming drift, root clutter, stale README layout | R1 §6, R2 §5 §7 | low | none | S |
| 9 | Web monoliths (`ChangeView`, `SettingsPage`, `styles.css`) | R2 §8 | low | low | M |

Verification for every item: `bun run typecheck && bun run lint && bun test`. As of
this writing `test/webkit.test.ts` is the one pre-existing environmental failure
(Playwright WebKit cannot launch here); "green" means that and nothing new.

## 1. Extract the duplicated CLI helpers

`shSoft` appears **8 times**, `cliJson`/`ghJson` **6 times**, `fs`
(`Effect.orDie(tryPromise)`) **4 times**, `messageOf` 6 times, and the `worst`
reducer 3 times. Roughly 150 lines of near-identical code, each copy carrying a
comment that explains the same invariant.

- Put `shSoft` (catch a `CliError` timeout into exit code 124) and `cliJson`
  (schema-decode-with-fallback) in one place — `src/effect/support.ts`, or as
  methods on the `Shell` service if item 2 lands first.
- Fold `messageOf` and `fs` in as well; both are one-liners with five identical
  doc comments.
- Point `worst` callers at `types.ts`'s existing implementation; `ci/index.ts`'s
  item-level variant can stay if it genuinely differs (it reduces `WidgetItem[]`,
  the shared one reduces `WidgetState[]` — make that distinction a named function
  rather than a second copy).

**Done when:** each helper has one definition, `bun test` is unchanged, and the
per-file "Result-branching contract" comment lives only where the helper is defined.

This is first because it is mechanical, touches no behaviour, and every later item
gets smaller once it is done.

## 2. Retire the dead Promise facades and the ALS shim — **decision first**

Verified dead in `src/`: `readChange`, `writeChange`, `listChanges`,
`createChange`, `archiveChange`, `provision`, `repoStatusOf`, `loadCache`,
`saveCache`, `readNotes`, `writeNotes`, `writeSidecar`. `shOrThrow` is dead
everywhere. `currentEnv` is test-only. `sh` has exactly one `src/` caller
(`src/tooling.ts`); `swr` has none (the only app-side `swr` is the `Cache` service
method, which is unrelated).

The chain that keeps `src/context.ts` alive: those facades cannot carry the
`Workspace` tag, so the ALS fallback in `currentWorkspaceEffect` exists for them.
`withWorkspace` is used only in `test/cache.test.ts`, and `provideWorkspace` has no
callers at all.

**This reverses a documented ruling.** `docs/guides/effect-conventions.md` says "Tests
pass unmodified except import paths" and keeps the facades "deliberately". So decide
first: are we willing to port the Promise-shaped tests to the Effect APIs (or a
small helper that provides the tag)? If yes:

- port the tests that call the facades;
- delete the facades;
- simplify `currentWorkspaceEffect` to read the tag, then delete the
  `AsyncLocalStorage` and `context.ts`, or reduce it to the thin helper the tests
  still need.

If no, close this item and record why in `effect-conventions.md`, so it is not
re-raised. A partial pass (delete only the facades with zero callers anywhere,
port only `test/cache.test.ts`) is a legitimate middle path.

## 3. `src/shared/` for the browser/server boundary

`eslint.config.js` allows `src/web/**` to import `types.ts`, `branch.ts` and
`deployConventions.ts` by exception, with type-imports allowed everywhere. Every new
pure shared module means editing that allowlist.

- Create `src/shared/` for the pure vocabulary and pure functions both sides need
  (no `node:fs`, no CLI, no `Bun.spawn`).
- Move `branch.ts` and `deployConventions.ts` there, and move the browser-safe
  types out of `types.ts` if the split is clean; otherwise leave `types.ts` as the
  one type-only exception.
- Then the lint rule becomes "`src/web/**` may import `src/shared/**`", a structural
  rule rather than a list.

**Done when:** the allowlist is gone and the rule is a directory, not a list of
filenames.

## 4. Centralize the legacy settings precedence chain

The chain (extensionSettings bag → legacy flat field → env var → vendor default) is
implemented in four places: `deploySettings.ts`, `workspaces.ts`'s `azureOf`,
`config.ts`'s `load()`, and `migrateWorkspaceSettings()` in `extensions/index.ts`.
Retiring one legacy field later means touching all four.

- Move the legacy reads and the one-time migration into a single module
  (`settings.ts` or a new `legacySettings.ts`).
- Long term: a config version field, after which the legacy reads can be dropped.
  Not part of this item; just make the drop possible.

## 5. Colocate a feature's implementation with its extension

Do deployments first — it has the fewest legitimate shared consumers.

Current homes for one feature:

- **deployments**: `extensions/deployments/` + `src/deployments.ts` +
  `src/deploySettings.ts` + `src/deployConventions.ts` + `src/integrations/azure.ts`
- **ci**: `extensions/ci/index.ts` + `integrations/{github,azure,checks}.ts`
- **git**: `extensions/git/index.ts` + `integrations/git.ts`

Pick one rule and write it down in `docs/guides/extensions.md`:

- `extensions/<name>/` = declaration, wiring, and the feature's own implementation;
- `integrations/` = vendor clients genuinely shared by more than one feature
  (`git.ts` qualifies; `azure.ts`/`github.ts` do not, if nothing else uses them);
- top-level `src/*.ts` = core domain that is not a feature.

Caveats to respect while moving deployments:

- `workspaces.ts`'s `azureOf` still reaches into the legacy settings chain for the
  fallback — keep that import path working (item 4 makes this clean).
- Moving files changes import paths across tests; do it as one commit per feature
  so a bisect lands somewhere sensible.

**Done when:** the rule is documented and deployments is the worked example.

## 6. Split `extensions/index.ts`

597 lines holding the registry, discovery/loading, the built-in list, migration,
eight near-identical workspace selectors, provisioning/status/run execution, and the
route dispatcher.

- `registry.ts` — `loaded`, `install`, `normalize`, the loaded-extension type
  (a leaf with no built-in imports);
- `discover.ts` — `extensionModulePaths`, `loadDiscovered`, `loadAll`;
- `selectors.ts` — the workspace queries, with one generic helper instead of seven
  `flatMap`s;
- `dispatch.ts` — `matchRoute`, `dispatchExtensionRoute`.

Putting `loaded` in the leaf `registry.ts` is also what lets `terminal.ts` import
the presenters registry directly instead of going through the `presenters.ts`
`setPresenterSource` indirection. That indirection exists for a real cycle
(`extensions/index → services → events → terminal → extensions/index`); with the
registry split out, the cycle is gone rather than worked around.

## 7. Split `server.ts`

652 lines, 38 route keys, mixing bootstrap (cache restore, client-chunk build, the
page-build check), request helpers (`withChange`, `bodyOf`, `attempt`) and the route
table. Compose the table from `src/routes/{changes,terminals,repos,settings,
extensions,assets}.ts`; keep bootstrap in `server.ts`. Bun's `routes` accepts a
composed object, so this is mechanical. Do it after item 6 so the extension routes
already have a home.

## 8. Naming drift, root clutter, stale docs

No behaviour, all reading cost:

- **Done:** `agent-state.ts` was a **pi** extension, not an IWE one, sitting in a
  root `extensions/` directory one apart from `src/extensions/`. The directory is now
  `pi/`, and `scripts/extension.ts` and `test/agentState.test.ts` point at
  `pi/agent-state.ts`.
- "integration" vs "extension": align internal names (`cardByName`,
  `IntegrationInfo`, the `:integration` route param) where it does not touch the
  wire. `Widget.integration` *is* the wire contract for out-of-tree extensions, so
  leave it and add one line to `docs/guides/extensions.md`: "integration is the legacy
  spelling of extension".

**Done** (the "docs: split documentation by lifetime" commit): the root migration
artifacts moved to `docs/plans/archive/`, and the README "Layout" section was rewritten
— it had drifted onto files that no longer exist — to point at [`docs/README.md`](../README.md).
The layer narrative now lives in [`docs/guides/architecture.md`](../guides/architecture.md)
and is kept there; the README map only lists what exists.

The README is 84KB and has become the manual. Splitting reference material into
`docs/` is reasonable but is a documentation project; keep it out of the structural
sequence unless someone wants to own it.

## 9. Web monoliths

`ChangeView.tsx` (773), `SettingsPage.tsx` (626), `styles.css` (2030). Extract
sub-components and section files when the next change has to touch them — not as a
standalone project. `app.tsx` also inlines URL↔view parsing (`viewOf`/`pathOf`);
a `web/router.ts` would make the shell readable, but this is cosmetic.

## Decisions needed before work starts

1. **Facades and tests (item 2).** Port the Promise-shaped tests, or keep the
   facades and record it? This is a ruling in `effect-conventions.md`, not a
   cleanup.
2. **Wire rename (item 8).** `Widget.integration` stays; internal names align.
3. **Feature rule (item 5).** Confirm the three-way split before moving files, so
   deployments is the example and not a one-off.

## Explicit non-goals

The additive extension model, the stale-while-revalidate cache with its two honesty
rules, the "events carry news, not data" SSE design, and ttyd proxied through our
own origin are deliberate and correct. Nothing here changes them.

## Suggested sequence

1. Item 1 (helpers) — mechanical, unblocks the rest.
2. Decide item 2, then do it if the answer is yes.
3. Items 3 and 4 — small and independent.
4. Item 5 (deployments first) — the largest navigational win.
5. Items 6 and 7 — mechanical splits.
6. Items 8 and 9 — reading cost and web cleanup, ongoing.
