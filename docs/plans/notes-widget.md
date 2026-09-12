# Notes back on the dashboard as a client-drawn widget

> **Kind:** plan · **Status:** active

Notes used to be a textarea on the change dashboard; slice E4 moved it to a
change tab of its own. This plan puts the textarea back on the dashboard —
owned by the notes extension, honouring per-workspace enablement — and removes
the tab, so there is one editor, not two.

## Why a new surface, not `cards`

A `Card.status` effect answers with a server-drawn `Widget`: rows, states,
summaries, polled every 15 seconds. A textarea is the opposite shape: client
state (debounce, an `unsaved` marker, never overwrite what is being typed, Home
and End meaning the line's edges). Encoding text into `summary`/`items` plus
`run` actions would lose that behaviour and risk a poll overwriting typing. The
tab surface already proved the right split — the server declares existence, the
client half owns the component — so the dashboard gets the same split: a
**client-drawn widget** surface that mirrors `changeTabs` end to end.

The alternative of hard-coding `NotesCard` back into `ChangeView` is rejected:
it would bypass per-workspace enablement and break the rule
`architecture.md` states outright — the dashboard is core, every card on it is
an extension.

## What changes

**Contract** (`src/extension-host/`): a new `api/widgets.ts` with
`DashboardWidget = { id, title, wide? }` and
`WidgetComponent = ComponentType<{ change, workspace? }>` — the same props as a
tab, a different surface. (`DashboardWidget`, not `Widget`: `domain/widget.ts`
already owns that name for the server-drawn shape.) `Extension` gains
`dashboardWidgets?`; the registry normalises it; `selectors.ts` gains
`widgetsFor(change)` in load order; `routes.ts` gains
`GET /api/changes/:id/widgets`; `client.tsx` gains `WidgetHost` (registry
lookup, `/extensions/<name>/client.js` fallback, the same "no widget on this
side" error as `TabHost`) and `ClientModule` gains `widget?`. No change needed
in `clientChunks.ts`: the whole `client.tsx` is built, so a `widget` export
rides the existing chunk.

Widgets are additive with no address conflict — two extensions may each draw
one, keyed by extension plus id — so unlike tabs there is no first-wins rule
and no reserved ids.

**Notes** (`src/extensions/notes/`): `changeTabs` becomes
`dashboardWidgets: [{ id: "notes", title: "Notes" }]` (narrow, its old
left-column seat); `export const tab` becomes
`export const widget`. `NotesCard` itself, the two `/api/ext/notes/` routes and
`server.ts` (`ExtensionStore` plus the `readSidecar` fallback) are untouched —
no data migration. A stale `/changes/:id/notes` URL already falls back to the
dashboard through `resolveChangePage`; nothing to change there.

**Dashboard** (`src/change-page/client/ChangeView.tsx`): fetch the widget list
beside cards and tabs (cached per change, `${id}:widgets`), render narrow
widgets after the narrow cards and wide ones after the wide cards. Widget hosts
are deliberately *not* keyed by the `generation` counter that remounts server
cards after a merge — remounting would drop in-flight typing, which is why the
old card never remounted either. Unmount-on-leave still flushes through the
existing unmount effect.

## Tests

- `test/notes.test.ts`: the offered/hidden test moves from `changeTabsFor` to
  `widgetsFor`, keeping the stale-URL-falls-back assertion; the store-migration,
  404/400 and `readSidecar` tests are untouched.
- `test/extensionParity.test.ts`: count `dashboardWidgets` as an interface in
  both directions.
- `test/extensions.test.ts`: pin the new selector (enablement filtering, load
  order, duplicates coexist).
- `test/changeTabs.test.ts` (or beside it): pin the
  `GET /api/changes/:id/widgets` route through the real guarded handler.
- `test/outOfTreeExtensions.test.ts`: the fixture client exports `widget` too,
  and the chunk assertion covers all four surfaces.
- `test/webkit.test.ts`: the notes assertions run against the dashboard URL
  (`/changes/${id}` showing `textarea.notes`), not the gone tab URL.

## Docs

- `docs/guides/extensions.md`: the new row in the surfaces table, a short
  section, and the notes worked-example wording (widget, not tab).
- `docs/guides/architecture.md`: the dashboard paragraph — it composes
  server-drawn cards *and* client-drawn widgets.

## Verification

`bun run typecheck && bun run lint && bun test` (full suite). By hand: notes
enabled shows the textarea on the dashboard; disabled hides it; typing,
leaving, and reloading preserves text; a stale `/changes/:id/notes` URL lands
on the dashboard with notes visible.

## Risks

- **Two editors at once** (keeping the tab too): rejected — one file, one cache
  key, but separate `pending` refs means last-unmount-wins.
- **Finished changes stay editable**: the widget does not go through the
  server cards' `readOnly` action-stripping, same as the old card — stated here
  so nobody "fixes" it.
