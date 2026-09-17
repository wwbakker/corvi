# The interface

![The changes list](../images/home.png)

## Navigation

One column, down the left, from the top of the window:

    Changes                          the overview
    IDEAS  New                       the ideas, and the button that starts one
    ┃ New idea                       the draft you have not created yet — clicking it goes back
    ┃ Wait for the security review…  ▶     the changes still going; picking one opens its dashboard
    ┃ Anonymise customer names…       ▶
        >_ PROJ-1234                  its terminals, under the change they belong to
        >_ example-web - (pi working)

    Dashboard | Review changes       tabs on the change itself

A breadcrumb, a row of tabs and the terminal's own window strip would say where you are three
times and disagree about how. Everything you can go to is here, one level deep: **a terminal in
another change is one click**, not four.

There is no "Dashboard" entry, because picking a change opens it, and no "Terminals" heading,
because the icon on each row already says what it is. What is left is one flat list of
destinations. The change's two views — **Dashboard** and **Review changes** — are tabs on the
page instead, since they are two ways of looking at one change rather than two places to be.

Every change's windows come back from **one** call, `GET /api/terminals`: `tmux list-windows -a`
answers for every session there is, and the sessions that are not ours are dropped by their name.
Asking per change would be a process per change every few seconds.

A change is two lines — its id, then what it is about — with **a coloured bar down the left** for
its state, in the usual amber/purple/blue/green. A colour along the whole row reads from further
away than a dot does, and it leaves the icons to say what the *tools* are doing rather than what
you have decided.

One icon is left: a play button for the builds, coloured by the worst of them, from the same
`/api/changes/:id/summary` the overview cards use and refreshed every thirty seconds — this is a
glance, not a monitor. There is no terminal icon on a change, because its terminals are the rows
underneath and each says how it is doing itself.

**One thing is highlighted at a time.** On a terminal, that is the window — not the change it
belongs to, which stays plain until you are on its dashboard or its review tab. Two highlights
would be two answers to "where am I". On the wizard it is the draft row under Ideas.

**The idea being written is a row too.** The draft you get by pressing **New** and then leaving
before creating anything sits under Ideas — *New idea*, or its title once you have typed one — and
clicking it reopens the wizard where you left it. Leaving the wizard loses nothing, because the
form is kept in the page until **Create idea** or **Discard**
(see [`changes.md`](changes.md#creating-an-idea)).

A terminal's icon is green while its window runs something and grey while it sits at a prompt.
**`>_ new`** appears only under the change you are working on: every change offering a terminal it
has not got would be more noise than help. On a change whose session has not started, it opens the
terminal — which starts one, with the window you were asking for.

**Opening a change starts nothing.** A terminal connects when it is opened, not when the
dashboard is: connecting on arrival left a tmux session — and a pty — behind for every change
you so much as looked at. A change needs no terminal at all some days.
The cost is that the first terminal of a change takes a moment to appear, which is the honest
price of not starting one behind your back.

The column is **resizable**: drag its edge, and the width is remembered in `localStorage`. The
whole edge is the handle, because that is what you aim at, and the drag is followed on the window
rather than on the handle, since the thing being dragged moves out from under the pointer.

The pages of a change appear only once a change is picked, and disappear again on the overview.
Each page keeps its own URL, so a deep link opens exactly what you linked to.

## Looking at the UI

```bash
bunx playwright install chromium   # once (webkit too, only for the other-engine run)
bun run shot                       # Chromium, into shots/
CORVI_ENGINE=webkit bun run shot
```

Walks home → wizard → each step against `CORVI_URL` (default `http://127.0.0.1:4000`) and reports
any console errors. Faster than describing a layout bug in prose.

**Chromium by default, because that is what the app is**: the window is Electron, and Electron is
Chromium ([`../decisions/electron-host.md`](../decisions/electron-host.md)). WebKit stays a variable away, because the page is a
web page first and Safari still opens it; `test/pages.test.ts` runs the page suite in Chromium by
default and takes `CORVI_ENGINE=webkit` for that check.
and it still catches what Chromium tolerates (a missing route once came back as the app's own HTML
with a `200`, which WebKit words as *"The string did not match the expected pattern"*).

```bash
bun run app:permissions   # what this terminal may do to the app's own window
```

```bash
bun run app:run                             # the window, straight from the checkout
bun run app:drive                           # open it with Playwright and report what it did
bun run app:drive --shot --notify           # ... with a screenshot and a notification check
bun run app:sandbox 4090 --open             # a copy that cannot be mistaken for yours
```

**Never test against the installed app.** `app:sandbox` makes a copy with its own bundle
identifier, its own name and its own port, pointed at whatever scratch server you like. A copy
made with `cp -R` keeps the identifier `nl.wwbakker.corvi`, and `tell application id "nl.wwbakker.corvi" to
quit` then goes to whichever bundle the system resolves — which is how quitting a test copy quit
the real app instead, in the middle of somebody's work. Everything that addresses a bundle now
addresses a **path**, which is exactly one app.

`app:drive` opens the app's window through Playwright's Electron driver, so the window itself —
not just the page — can be checked without a human describing it: it reports the title, the URL
the window loaded, whether the host bridge is there, and any console errors, and it can take a
screenshot and exercise the host's notification path. It replaces the AppleScript that walked the
Swift app's accessibility tree; it needs no Accessibility permission, and it runs on Linux too.

The page is driven by Playwright (`bun run shot` and the suite); the parts that are not the page —
the title bar, the Dock icon, a notification banner — can only be checked by looking at the real
thing, and macOS gates screenshots and clicking behind permissions granted per application.
`bun run app:permissions` reports where those stand.

