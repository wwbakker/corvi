# The interface

![The changes list](../images/home.png)

## Navigation

The left column contains the workspace switcher, change overview, ideas, active changes and their
terminal windows. Settings stays at the bottom. The column is resizable and remembers its width
in the browser.

Ideas are separate from work in progress. An unfinished wizard appears as **New idea** or the
title you typed; opening it restores its draft. Only one destination is highlighted: a terminal
window, a change view, or the draft being edited.

Selecting a change opens its **Plan** — the first of its views. **Plan**, **Dashboard** and
**Review changes** are views of that change; terminal windows can also be opened directly from
the navigation column. Each view has a URL, so deep links, reload, and browser Back work.
Coming back to a change's overview — from a terminal window, or by opening the change again —
lands on the view you last had open there, within the running app: restarting opens the plan
again. Leaving Settings with unsaved edits asks first however you go — clicking or Back — see
[configuration](configuration.md).

Opening a dashboard does not start a terminal. A terminal starts or attaches when opened. The
new-window control creates another window, normally in the current window's working directory.

## Change views

A change's name, state, and actions remain accessible above its content. The **Plan** tab is
`PLAN.md` as Markdown source filling the tab — the markup stays visible, in a monospace face,
colored as an editor colors it. Tab indents in the editor (Escape, then Tab, moves focus on
instead). The text follows the file when it changes outside Corvi — an agent or an IDE editing
it — and when edits are in flight it asks before either version goes away. How far into the plan
you were is remembered as you move around, within the running app. The dashboard places notes
documents in the left column and status cards in the right; narrow windows stack the
documents first. Status cards load independently, so one slow integration does not block the
whole page. Returning to a view can show cached data while it refreshes.

The overview and navigation show facts such as active pipelines, active terminal processes, and
review threads waiting on you. Colored indicators summarize status; the change's lifecycle state
is a separate choice, not inferred from those tools.

## Desktop and browser

The desktop application uses the same page as a browser, with native window controls,
notifications, dialogs, and external-link handling. Its header includes a draggable area;
interactive controls must remain clickable. On macOS the traffic lights occupy reserved space.
Renaming a change belongs in that change's action row, not in the window's general title area.

The context-menu setting controls the browser/desktop right-click menu outside the terminal.
The terminal retains tmux's own mouse behavior. See [terminals](terminals.md) for keyboard and
clipboard shortcuts.

## Checking the interface

Developer commands:

```sh
bunx playwright install chromium
bun run shot
CORVI_ENGINE=webkit bun run shot
bun run app:permissions
bun run app:run
bun run app:drive
bun run app:drive --shot --notify
bun run app:sandbox 4090 --open
```

Screenshots use `CORVI_URL` (default `http://127.0.0.1:4000`) and are written under `shots/`.
Chromium is the primary engine because Electron uses it. Optional WebKit checks require a
working Playwright WebKit installation.

**Never test against the installed app.** Use isolated data and an explicitly owned development
server. A desktop sandbox must have its own identity; copying an installed bundle while retaining
its application identifier can address the wrong running app. Check each tool's target before
using it. Native window/notification behavior still needs platform-specific verification.

For automated suite setup and cleanup, follow the [testing guide](../guides/testing.md).
