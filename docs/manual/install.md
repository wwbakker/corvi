# Installing and running

## Requirements

`git`, `wt`, `gh` and `az` for the integrations; `tmux` for the Terminals tab. Jira is
talked to over its own REST API, but `jira-cli` is still what configures it — see
[Jira over its own API](integrations.md#jira-over-its-own-api).

The terminal's pty is `node-pty`, installed with the rest of the dependencies. Its prebuilt
binaries cover macOS and Linux on x64 and arm64, so `bun install` needs neither a C toolchain nor
python3; a platform they do not cover falls back to `node-gyp` and does. It is pinned to a `1.2.0`
beta, for the reason in [`../decisions/node-pty-prebuild.md`](../decisions/node-pty-prebuild.md).

The same list applies on Linux (on Arch: `sudo pacman -S git worktrunk gh github-cli tmux`).
`wt` is [Worktrunk](https://github.com/max-sixty/worktrunk) — a cross-platform Rust CLI with an
official Arch package, and every invocation Corvi makes was verified to behave identically on Linux
(`brew install worktrunk` on macOS; details and non-Arch installs in [`../decisions/wt-on-linux.md`](../decisions/wt-on-linux.md)).

The app's own window needs nothing extra on either platform: it is Electron, which `bun install`
downloads with the rest of the dependencies ([`../decisions/electron-host.md`](../decisions/electron-host.md)), and the server
inside it runs on Electron's own Node — so Bun is the toolchain for installing and developing
Corvi, not something an installed app needs at runtime ([`../decisions/node-server.md`](../decisions/node-server.md)). The page
itself is still a web page — any browser opens it. Developing needs Node 24+ as well: `bun run
dev` starts the server with `node --watch`, and `bun test` spawns its servers with `node`,
because the terminal's pty library delivers nothing under Bun
([`../decisions/node-pty-terminal.md`](../decisions/node-pty-terminal.md)).

## Run

```bash
bun install
bun run dev          # http://127.0.0.1:4000
```

`dev` is `node --watch` (Node 24+): a restart rather than a re-evaluation of modules inside the
running process. The difference matters here: the server takes its routes once,
at startup, so under `--hot` a **newly added route never appears** — the request falls through to
the app's own HTML and arrives as a perfectly good `200 text/html`. The page then tries to parse
that as JSON and reports whatever the browser calls a parse error (Safari: "The string did not
match the expected pattern"), which is a sentence about nothing. Restarting is cheap: the cache
is on disk and the terminals belong to tmux, so both survive it.

The page is built by esbuild (`src/app-root/client.ts`) and, in development, rebuilt when its
sources change — editing the UI is a refresh, not a server restart.

The browser now says so plainly instead — anything answering an `/api` call with a non-JSON body
is reported as "the server has no /settings — it is probably running older code, restart it".


## The app

```bash
bun run app:install      # macOS: ~/Applications/Integrated Work Environment.app
bun run app:uninstall    # Linux: desktop entry, icons and the corvi launcher
```

A real application: an icon the app grid knows, a window whose title bar is the page's own first
row — no band of the system's above it. On the change pages that row is the change's name with its
terminals beside it, and the row under it is the change's own tabs with its state and its actions;
both stay put while the page scrolls ([`../decisions/window-titlebar.md`](../decisions/window-titlebar.md)) — and the server inside
it. Clicking it **starts the app's own server — on a fresh port, picked at launch** — shows
"Starting Corvi…" on the page's own background while it waits, then loads the app.

**The app always runs the production build, on a fresh port.** `bun run dev` keeps 4000. A shared
port would let the window attach to whatever is listening there: a dev server left running from
last week would silently become "the app", with last week's code and no way to tell from the
window, which is how a missing `/api/settings` surfaces as "The string did not match the
expected pattern". A port of its own avoids that, but a *stale* server can still be sitting on a
fixed one. So the window picks a free port at each launch and starts its own server on it: there
is nothing to attach to by mistake, and nothing to collide with.

The two are separate things rather than two ways to start the same thing:

| | `bun run dev` | the app |
| --- | --- | --- |
| for | editing Corvi | using Corvi |
| port | 4000 | fresh each launch |
| build | rebuilt as you edit | built once, `NODE_ENV=production` |
| on a code change | restarts itself (`--watch`) | picks it up when you next launch it |
| output | your terminal | macOS: `~/Library/Logs/corvi.log` · Linux: `~/.local/state/corvi/log` |

It is one Electron main process (`scripts/app/electron/main.ts`) on both platforms: the installer
builds it into the app's bundle — a macOS `.app` that wraps Electron, or, on Linux, the desktop
entry, icons and `corvi` launcher that runs it — and the window loads the same HTTP server any
browser opens. Quitting the app stops the server it started; a server you started yourself, in a
terminal, is left alone. The app is a convenience, not the product.

What the window buys over a Chrome `--app` window:

- **A dark window from the first frame.** `backgroundColor` and a dark appearance, where a plain
  `--app` window flashes white before the page paints.
- **A Dock icon that means something**: it is there while Corvi is running, and Quit stops it.
- **cmd-t is ours.** Chromium keeps it for new tabs in a browser; the app keeps no menu that could
  take it from the page (the terminal's own chord, on Linux, lives in the page).
- **Links leave.** Jira, GitHub and Azure DevOps open in your browser rather than replacing the
  page.
- **The page's questions get asked.** Chromium draws `alert`, `confirm` and `prompt`; the app
  draws none of them itself, and every confirmation in Corvi — cancelling a change, a removal that
  would lose commits, deleting a leftover — behaves in the app exactly as it does in a browser.

Two details that took a bug each, and survive from the hosts this replaced:

- **It runs an interactive login shell** (`zsh -ilc` on macOS, your `$SHELL` elsewhere). A bundle
  launched from the Dock or a desktop entry inherits nothing, and `JIRA_API_TOKEN` and friends are
  exported from `~/.zshrc`, which a *non-interactive* login shell does not read. The server
  itself runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`), so Bun is not part of running the
  app ([`../decisions/node-server.md`](../decisions/node-server.md)).
- **The root lives in the bundle's `package.json`** (`corviRoot`), not in the binary, so moving the
  repository is a reinstall rather than a rebuild. The port is nobody's to configure: the window
  picks a free one at launch.

Why Electron rather than the system's own web view: it is the same engine on both platforms, so
the window is developed and tested where it runs, and the capabilities the old hosts hand-built —
dialogs, notifications, microphone, links — are the engine's. It costs a Chromium in the bundle;
the trade is recorded in [../decisions/electron-host.md](../decisions/electron-host.md).

`app:install` **quits a running app and puts it back on the new build**: `open` on a running
application only focuses it, so a rebuild would otherwise leave you looking at the previous one —
a confusing ten minutes the first time it happens. On macOS it quits with an Apple Event rather
than a signal, so the app stops the server it started instead of orphaning it, and it builds to
one side first, so a failed build leaves the app you have alone.

Failures land in `~/Library/Logs/corvi.log`, and a server that never answers leaves the window
saying so rather than showing an empty page.

### On Linux

The same `app:install` puts four things in your home directory: a **desktop entry**
(`~/.local/share/applications/corvi.desktop`), **icons** rendered from `assets/icon.svg` into
`~/.local/share/icons/hicolor/<size>/apps/corvi.png` (skipped with a note if `rsvg-convert` is
missing — the app works without one), a **launcher**, `~/.local/bin/corvi`, with the repository
written in (`corviRoot`'s counterpart: moving the repository is a reinstall, not a rebuild), and the
built Electron window under `~/.local/share/corvi/app`. The port appears nowhere — the window picks
a fresh one at launch.

The window is the same Electron main as on macOS, so the dark first frame, dialogs, links to
Jira, GitHub and Azure DevOps, the microphone and notifications all come from Chromium rather
than from a second Python implementation ([`../decisions/electron-host.md`](../decisions/electron-host.md)). Without an Electron
binary in the checkout the launcher falls back to your installed Chromium's `--app` mode.

Lifecycle: clicking the icon (or running `corvi`) opens the window, which then manages the
server: it starts one of its own — on a fresh port, picked at launch, through your login shell so
`bun` and `JIRA_API_TOKEN` come from your rc file — and **closing the window stops the server it
started**. Terminals are tmux's and survive that, which is the same promise a restart of the
server has always made. The window records the pid of the server it started in
`~/.local/state/corvi/corvi-<port>.pid`, so `corvi stop` can still stop a server left behind by
a window that died harder than it could clean up after; it checks each pid is still a Corvi server
and refuses anything else. Logs land in `~/.local/state/corvi/log`. Without Electron the launcher
falls back to the browser's app mode, where the server is started detached and outlives the tab —
a browser window cannot clean up after anything. `app:uninstall` removes the entry, launcher,
icons and built window and leaves the logs alone.

## Installing it as an app

The page ships a web manifest and icons, so it installs as a standalone app — on macOS through
the browser, on Linux the desktop entry `app:install` writes plays that part:

- **Safari** — open the app, File → *Add to Dock*.
- **Chrome** — ⋮ → Cast, Save and Share → *Install page as app*.

Installed, the layout uses the full window (`@media (display-mode: standalone)`); in a browser tab
it keeps a readable 1200px column.

`http://127.0.0.1:4000` counts as a secure context, so no TLS is needed. The icon source is
`assets/icon.svg` (and `assets/icon-maskable.svg` for the padded, croppable variant); edit those
and run `bun run icons` to regenerate `src/app-root/icons/*.png` with `rsvg-convert`
(`brew install librsvg`). The generated PNGs are committed, so a clone serves them without it.

## From an older install

Before this release Corvi was called IWE: the environment variables were `IWE_*`, the config
lived in `~/.config/iwe`, and changes in `~/changes`. Nothing is read from the old names any
more, so an install from before the rename moves once:

```bash
bun run migrate:iwe              # what would move
bun run migrate:iwe --apply      # move it
```

The script moves the config, cache and state directories; the changes root and its archive; the
`wt.toml` worktree paths and the git worktrees that moved with them; and the pi sessions whose
working directory was under the old root — their directory and the `cwd` in their header. Stop
Corvi, its terminals and any agent working in a change before running it, and `bun run
app:install` afterwards so the launcher, entry and icons are Corvi's. The script is temporary
and will be deleted once installs have moved.
