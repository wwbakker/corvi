# The page's own first row is the window's title bar

> **Kind:** decision · **Status:** accepted

## Context

The window had a native title bar everywhere: the platform drew the band, the app's name in it, and
macOS its traffic lights. It was the last piece of chrome that was not IWE's — 28px of the window
saying "Integrated Work Environment" while the page below it already said what you were working on.
The change is `~/changes/make-iwe-content-part-of-title-bar/PLAN.md`; the item was found and parked
in `~/changes/archive/improvements-and-issues-found/PLAN.md` §5.

The page is also opened in a plain browser (`docs/decisions/electron-host.md`), where there is no
title bar, no traffic lights and nothing to drag — and it has to stay a first-class view of the same
server, not a lesser one.

## Decision

**macOS: no title bar of Apple's; `titleBarStyle: "hidden"` with an explicit
`trafficLightPosition`.** The traffic lights stay, placed at coordinates we choose rather than at
`hiddenInset`'s, so the strip's cleared width is a constant the page can lay out against. Linux gets
no window configuration at all: on the compositors this app is used on there are no decorations to
remove, and `titleBarOverlay` would *add* Chromium-drawn window buttons nobody asked for.

**The band follows the columns instead of sitting above them.** `.app` stays a row of two
full-height columns, and each column's top gains a row of the same height: the sidebar's holds the
workspace switcher beside the lights, the content's *is* the page header. Nothing about the
sidebar's width or its `height: 100vh` has to change, and the full-width bar above both columns —
`titleBarStyle: "hidden"` plus one row spanning the window — was rejected for exactly that cost.
Both columns are the same `--surface` tone with no line between them, so the top of the window reads
as one piece of chrome rather than two panels meeting (the palette is `docs/guides/style.md` §11).

**The page's first row is the strip, on every page.** `.page > header` (and the wizard's) becomes
one `--titlebar-height` row, full-bleed, in the `--surface` tone: "Changes" with its **New** button,
"Settings" with Save, and on a change its terminals as tabs. An extension page's own header serves as
its strip when it has one; the sidebar's band is the drag area on every page regardless, so the
extension contract does not change.

**A change's row says nothing about the change.** The window's own row is the terminals — a tab per
window, which is also the way back to its overview — and the key reference on the terminal page. The
change's name is the navigation column's entry (and the window's title, `document.title`), not a label
in the window's chrome: the name was the one thing in that row nobody could act on, and the column
already carries it beside the entry that opens it.

**A change has a second row, and both stay put.** Under it is the row the change already had: its
own views as tabs, and — at their height, on the right — its state and its actions. It is full-bleed
and sticky like the row above it, at `--titlebar-height` below it, so the page scrolls under its
chrome instead of taking it away. The state and the actions belong to the change rather than to any
one of its views, which is why they sit in the row that says which view you are in, and why the
terminal page — which has no such row — does not carry them at all.

**Renaming is an action, not the name.** The name used to be a button you clicked to edit; in the
window's own row a button is a hole in the region you drag the window by, so "Rename change" became
the first entry in the Actions menu. Picking it opens a field for the name in the change's own row,
beside the state it already carries — the same edit it always was, in the row that is not chrome and
not a drag region.

**Drag regions, with the controls kept out of them.** The band and the 
strip are `-webkit-app-region: drag`; every `button`, `select`, `input` and `a` inside them is
`no-drag`. That leaves the empty space — the `.spacer` between a row's content and its controls — as
the surface that moves the window, and keeps the window tabs' own reorder drag, the sidebar's
resize handle and the switcher clickable. Double-click-to-zoom comes with the region. The row *under*
the strip is not a drag region at all, which is where the change's controls live.

**One copy of the numbers.** `src/domain/chrome.ts` holds the row's height and the traffic lights'
position and inset. The main process imports it for the `BrowserWindow`, the page imports it for the
CSS variable — a mismatch would be a strip whose contents sit beside the buttons instead of under
them. The page needs to know only whether it is in the app at all, which is the host bridge that
already exists (`src/domain/host.ts`, read synchronously through `src/app-root/host.ts`); a browser
gets no marker, so the drag rules are inert and the row is an ordinary page header.

**The change's rows lose the id.** An idea's and a change's name is its ticket's summary, and the id
was what the sidebar's entries led with and what the change's header showed before the name. With the
strip carrying the name and the column's entries one line each, the id is the tooltip on a change's
entry (`Sidebar.tsx`, the branch, which starts with it) rather than a line of its own. The home
page's cards and the finished-changes table still lead with it: those are a list and a table, where
the id is the key you scan by.

**The window still has a title, it is just not drawn.** `document.title` follows the change, so
Mission Control, the Dock menu and the task switcher name the work rather than the app. No
app-owned title text is drawn anywhere: Slack and Teams are the model, not a banner of our own.

## Consequences

- macOS looks like a real Mac app with the app's own content in the top row, and the traffic lights
  keep the position macOS users aim for. In fullscreen the row keeps its height and the lights come
  back on hover, so nothing re-measures: no IPC, no `window-controls-overlay` geometry events, no
  re-layout while the window resizes.
- Linux: on a compositor that draws nothing — Hyprland — the window already had no band, and now
  gets the same layout as macOS apart from the lights. A compositor that *does* draw server-side
  decorations would show its band above the app's row; the fix, if it is ever met, is to set the
  host marker on darwin only.
- Dragging the window is the least portable part of this (Wayland, X forwarding). Nothing else
  depends on it: with the marker off, the page is the page it was.
- `-webkit-app-region` swallows pointer events in the region it covers, so anything interactive
  inside the row must be listed as `no-drag` — the one rule to remember when adding a control to a
  page header. It is also why renaming does not live on the name.
- The sidebar's band stretches the switcher's menu box across the column. The dropdown is anchored
  to that box's right edge, so a shrink-wrapped box hangs the list off the left of the window — the
  one bug this layout produced, and the reason `MIN` rises by the lights' inset rather than the
  switcher being free to shrink.
- The browser view is unchanged apart from the header being taller and having no id: one layout,
  one look, and the same tests cover it.
