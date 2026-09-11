# Refactor plan

> **Kind:** plan · **Status:** implemented

A single prioritized list built from `docs/plans/review-1.md` (my review) and
`docs/plans/review-2.md` (the other agent's). Both are kept as written; this file only
decides *what to do, in what order, and how to tell it is done*.

Ranking is by (value ÷ risk) ÷ effort, not by how interesting the change is. Every
item below is behaviour-preserving unless it says otherwise; the two that are not
behaviour-preserving are flagged as decisions, not tasks.

## Progress

| Item | State | Notes |
|---|---|---|
| 1. Shared CLI helpers | done | `src/effect/support.ts` is the one home for `shSoft`, `cliJson`/`ghJson`, `messageOf` and `fs`; the two `worst` re-implementations point at `types.ts` |
| 3. `src/shared/` | done | `branch.ts` and `deployConventions.ts` live in `src/shared/`; the eslint boundary is the structural `../shared/*`, with `types.ts` the one filename exception (documented in the config) |
| 7. Split `server.ts` | done | `src/routes/{helpers,changes,terminals,repos,settings,extensions,events,assets}.ts` hold the route table; `server.ts` keeps bootstrap |
| 8. Naming/root clutter | done | the pi extension lives in `pi/`; internal vocabulary says "extension" (`cardForExtension`, `:card`, `CardInfo`), while wire fields keep `integration` |
| 9. Web monoliths | done | `ChangeView.tsx` and `SettingsPage.tsx` are split into `WidgetRows`, `WidgetCard`, `PerRepoCard`, `WindowTabs`, `SettingsFields` and `WorkspaceCard` |
| 4. Legacy settings chain | done | `src/legacySettings.ts` is the one resolver for the bag → flat field → env → default chain, and owns the one-time migration |
| 6. Split extension host | done | `src/extensions/` is registry (leaf), discover, selectors, effects, dispatch, with `index.ts` as the public face; the events cycle is structurally gone |
| 5. Colocate feature implementations | done | deployments (`extensions/deployments/server.ts`) and ci (`extensions/ci/checks.ts`) sit with their extensions; `integrations/{azure,github,git}.ts`, `deploySettings.ts` and `shared/deployConventions.ts` stay shared, and git cannot be colocated while `integrations/git.ts` is shared by the core |
| 2. Facades + ambient shim | done | the Effect APIs are the only public surface, tests run Effects through `test/helpers.ts` and scripts through `scripts/sh.ts`, and there is no ambient store. This supersedes the "facades kept for the test suite" ruling recorded in `docs/decisions/effect-migration.md` |

`test/terminal.test.ts`'s "a window that starts waiting is announced" waits for the server's own
`/api/terminals` read rather than on a wall-clock race, which keeps it deterministic.

## The list

| # | Item | Sources | Value | Risk | Effort |
|---|---|---|---|---|---|
| 1 | Shared CLI helpers | R1 §1 | high | very low | S |
| 2 | Promise facades and the ambient shim | R2 §2 | high | low | M |
| 3 | `src/shared/` for the browser/server boundary | R2 §6 | medium | low | S |
| 4 | Legacy settings precedence chain | R2 §3 | medium | low | M |
| 5 | Colocate a feature's implementation with its extension | R1 §5, R2 §1 | high | medium | M |
| 6 | Extension host (registry / discovery / dispatch) | R1 §3, R2 §4 | medium | low | M |
| 7 | Route table (`src/routes/*.ts`) | R1 §4, R2 §8 | medium | low | M |
| 8 | Naming, root clutter, docs | R1 §6, R2 §5 §7 | low | none | S |
| 9 | Web components (`ChangeView`, `SettingsPage`, `styles.css`) | R2 §8 | low | low | M |

Verification for every item: `bun run typecheck && bun run lint && bun test`. As of
this writing `test/webkit.test.ts` is the one pre-existing environmental failure
(Playwright WebKit cannot launch here); "green" means that and nothing new.

## 1. Shared CLI helpers

`src/effect/support.ts` holds the one definition of each helper: `shSoft` (catch a
`CliError` timeout into exit code 124), `cliJson` (schema-decode-with-fallback),
`messageOf` and `fs` (`Effect.orDie(tryPromise)`). `worst` callers point at
`types.ts`'s implementation; `ci/index.ts` keeps its item-level variant because it
reduces `WidgetItem[]` rather than `WidgetState[]`, and that distinction is a named
function rather than a second copy. The per-file "Result-branching contract"
comment lives only where the helper is defined.

## 2. Promise facades and the ambient shim

The Effect APIs are the only public surface. Tests run Effects through
`test/helpers.ts` and scripts through `scripts/sh.ts`. The workspace travels in the
`Workspace` tag (`src/effect/tags.ts`), read at run time by `sh` and by the `Shell`
capability's live layer (`src/extensions/services.ts`); there is no ambient store.
This supersedes the "facades kept for the test suite" ruling recorded in
`docs/decisions/effect-migration.md`.

## 3. `src/shared/` for the browser/server boundary

`src/shared/` holds the pure vocabulary and pure functions both sides need (no
`node:fs`, no CLI, no `Bun.spawn`): `branch.ts` and `deployConventions.ts`, plus the
shared types that still live in `types.ts`. The lint rule is structural —
`src/web/**` may import `src/shared/**` — with `types.ts` the one filename
exception, documented in `eslint.config.js`.

## 4. Legacy settings precedence chain

`src/legacySettings.ts` is the one place that resolves the chain (extensionSettings
bag → flat field → env var → vendor default) and owns the one-time migration, so
retiring a field means touching one module. A config version field, after which the
flat reads can be dropped, remains a possibility; the single resolver is what makes
that drop possible.

## 5. Colocate a feature's implementation with its extension

A feature's implementation lives with its extension: `extensions/deployments/` holds
`server.ts`, and `extensions/ci/` holds `checks.ts`. The rule is documented in
[`../guides/architecture.md`](../guides/architecture.md#where-a-features-code-lives),
with deployments as the worked example.

Left shared, and why:

- `integrations/azure.ts` — deployments + ci;
- `integrations/github.ts` — the core's `complete`/`description` + ci;
- `integrations/git.ts` — the core + the git extension (so **git cannot be colocated** while
  this client is shared by the core);
- `src/deploySettings.ts` — read by the shared `azure` client and by the core's `workspaces.ts`,
  so moving it would invert the layering;
- `src/shared/deployConventions.ts` — pure, needed by both halves of deployments.

## 6. Extension host

`src/extensions/` splits into `registry.ts` (the leaf: `loaded`, `install`,
`normalize`, the loaded-extension type), `discover.ts` (`extensionModulePaths`,
`loadDiscovered`, `loadAll`), `selectors.ts` (the workspace queries, one generic
helper instead of seven `flatMap`s) and `dispatch.ts` (`matchRoute`,
`dispatchExtensionRoute`), with `index.ts` as the public face.

`registry.ts` as a leaf is also what lets `terminal.ts` import the presenters
registry directly. The events cycle
(`extensions/index → services → events → terminal → extensions/index`) is
structurally gone rather than worked around.

## 7. Route table

`src/routes/{helpers,changes,terminals,repos,settings,extensions,events,assets}.ts`
compose the route table, including the request helpers (`withChange`, `bodyOf`,
`attempt`). `server.ts` keeps bootstrap (cache restore, client-chunk build, the
page-build check); Bun's `routes` accepts a composed object.

## 8. Naming, root clutter, docs

No behaviour, all reading cost:

- `pi/agent-state.ts` is the pi extension; the root directory is `pi/`, not
  `extensions/`, and `scripts/extension.ts` and `test/agentState.test.ts` point at
  it.
- Internal vocabulary says "extension": `cardForExtension`, the `:card` route param
  (URL shape unchanged), the client type `CardInfo`. `Widget.integration` and
  `ProvisionResult.integration` keep the wire spelling, and `docs/guides/extensions.md`
  notes that.

The root migration artifacts live in `docs/plans/archive/`; the README "Layout"
section points at [`docs/README.md`](../README.md), and the layer narrative lives in
[`docs/guides/architecture.md`](../guides/architecture.md), which lists only what
exists. The README is 84KB and has become the manual; splitting further reference
material into `docs/` is reasonable, but as a documentation project, not structural
cleanup.

## 9. Web components

`ChangeView.tsx` and `SettingsPage.tsx` are split into `WidgetRows`, `WidgetCard`,
`PerRepoCard`, `WindowTabs`, `SettingsFields` and `WorkspaceCard`. `styles.css`
remains the one large file, and `app.tsx` inlines URL↔view parsing (`viewOf`/
`pathOf`); a `web/router.ts` would make the shell readable. Extract further
sub-components when the next change has to touch them — not as a standalone project.

## Decisions taken

1. **Facades and tests (item 2).** Tests port to the Effect APIs through
   `test/helpers.ts`; no Promise facades remain.
2. **Wire rename (item 8).** `Widget.integration` stays; internal names say
   "extension".
3. **Feature rule (item 5).** A feature's implementation lives with its extension;
   shared vendor clients stay in `src/integrations/`.

## Explicit non-goals

The additive extension model, the stale-while-revalidate cache with its two honesty
rules, the "events carry news, not data" SSE design, and ttyd proxied through our
own origin are deliberate and correct. Nothing here changes them.

## Order taken

Helpers first (mechanical, unblocking the rest), then the facade decision, then the
small independent items, then deployments, then the mechanical splits. Items 8 and 9
are ongoing reading-cost work.
