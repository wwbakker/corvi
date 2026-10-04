# Installing and running

## Requirements

- Bun for dependency installation, builds, and development commands.
- Node 24+ for the development server and test servers.
- Git for repositories.
- `gh` and `az` for the GitHub and Azure DevOps integrations you use.
- Jira needs no CLI; configure its site, account, and token in Corvi.

```sh
bun install --frozen-lockfile
bun run dev
```

Development serves `http://127.0.0.1:4000`. The page is built ahead of time: `bun run dev`
builds it first (`bun run build:web`, into `apps/web/dist`), and `bun run dev:web` watches the
page's sources and rebuilds as you edit. The server itself only serves the built files.

Electron and node-pty are installed with the project. The pinned node-pty version includes
prebuilds for supported macOS/Linux x64/arm64 platforms. Do not assume unsupported platforms can
build it without additional tools. An installed Electron app runs its server on Electron's Node,
not Bun.

## Desktop application

```sh
bun run app:install
bun run app:uninstall
```

On macOS the installer creates `~/Applications/Corvi.app`. On Linux it installs a desktop entry,
icons, and a `corvi` launcher. The application starts its own server on a fresh port, displays a
startup screen until it is ready, and stops that server on quit. It does not stop a separately
started development server. The terminal host sessions survive application/server shutdown.

| | Development | Installed application |
| --- | --- | --- |
| Start | `bun run dev` | App icon or launcher |
| Port | 4000 by default | Fresh port each launch |
| Source changes | Server watches; rebuild the page with `bun run dev:web` | Picked up on next launch |
| Logs | Starting terminal | Platform log file |

The installed app records the checkout it runs from. Reinstall after moving the checkout or
changing the desktop host/installer; server and page edits are read on the next launch.
`app:install` leaves the app running on the new build when it is done — starting it if it was
not open, quitting and replacing a running installed app first — so do not use it as a test command.

The application starts through an interactive login shell so tools and exported credentials can
be found. If an integration works in a terminal but not the app, check the environment provided by
that shell. Do not put credentials into logs when diagnosing it.

### macOS

Logs are written to `~/Library/Logs/corvi.log`. The window supports native traffic lights,
notifications, external links, dialogs, and the terminal clipboard shortcuts.

### Linux

The installer uses:

- `~/.local/share/applications/corvi.desktop`
- `~/.local/share/icons/hicolor/` for icons
- `~/.local/bin/corvi` for the launcher
- `~/.local/share/corvi/app` for the Electron host
- `~/.local/state/corvi/log` for logs

Icon rendering uses `rsvg-convert` when available. The launcher has a Chromium app-mode fallback
when Electron is unavailable; that mode may leave its server running after the browser closes.
`corvi stop` checks recorded server identities before stopping them. Uninstalling leaves logs.

## Remote access

Corvi is local by default: the server binds loopback and only this machine can open it. Remote
access adds a second **loopback** listener that `tailscale serve` publishes on your tailnet, so a
client on another machine — a browser, or the desktop app pointed at the URL — reaches this
server. It never binds a network interface, and nothing is reachable without a paired device's
token.

Prerequisites: [Tailscale](https://tailscale.com) installed and logged in on this machine, with a
tailnet DNS name. Tailscale issues the TLS certificate, so the published origin is a secure
context and the clipboard, notifications and terminal APIs work there. Then, in Settings:

1. **Remote access** → **Enable remote access**, set the **Port** (the loopback port the external
   listener binds, default `4110`; `tailscale serve` publishes that port at https 443), and
   **Save**. The section reports whether the listener actually bound.
2. **Publish to Tailscale.** Corvi runs `tailscale serve --bg <port>` and shows the published
   `https://<machine>.<tailnet>.ts.net` link. **Stop publishing** removes only Corvi's own mapping
   and never resets the machine's serve configuration. If 443 already serves something else Corvi
   refuses with the reason; if 443 is *shared* with another handler it says so and leaves the
   manual `tailscale serve --https=443 off` to you, because it will not clear a tree it shares.
   The manual command is the fallback for all of this.
3. **Devices** → **Create a pairing code**. It is short-lived (five minutes) and single-use; copy
   it to the other machine.
4. On the other machine, open the published URL. An unpaired page shows a **Pair this device**
   screen; enter the code and a name. The device is paired, and its token goes into an `HttpOnly`
   cookie so page JavaScript never sees it.

That other machine then runs Corvi's page against this server: its terminals, changes,
integrations and CLI run *here*. The published URL opens in a **browser** — an installed desktop
app only ever loads its own loopback server, so it cannot be pointed at the tailnet URL. To see
this server's work in a desktop app instead, add this server as a remote workspace to that app's
own Corvi — settings → a context → **Hosted on another server**, or the
[workspaces](configuration.md#workspaces) file format.

Manage paired devices under Settings → Devices: the list shows each device's name, when it paired
and last authenticated, and **Revoke**. Revoking ends that device's access on its next request and
invalidates any outstanding pairing code. A device token grants full access as you, so revoke a
lost device promptly.

## The command line

The launcher is also the CLI. `corvi start` opens the app window (what bare `corvi` used to do);
`corvi stop` stops the servers recorded in the state directory; anything else is a control
command over the running server:

```sh
corvi change list
corvi change create PROJ-2 --title "A new idea"
corvi change repository list --change PROJ-1
corvi change show --change PROJ-1
corvi change phase Implementation --change PROJ-1
corvi action list --change PROJ-1
corvi action run review --change PROJ-1
```

Every command takes `--json` and then prints one JSON value on success or a JSON error envelope
on failure. The exit code says what happened without reading the text: `0` success, `1` failure,
`2` usage, `3` no server answered (or none owned the change), `4` the server refused the request,
`5` an await ended because a window was lost or a turn was interrupted, `6` an await reached its
five-minute horizon with nothing to report — check in on the subagents, then await again.
`--change` defaults to `CORVI_CHANGE_ID` — which the app sets in every pane of a change's
session — and then to the nearest `change.json` at or above the working directory.

`corvi change create <id> --title <title> [--branch <name>] [--workspace <id>]` makes an
`Ideation` change, with the title required; `--workspace` picks the workspace whose changes root
the recipe's `PLAN.md` path names. Its response prints the next steps: write the change's
`PLAN.md`, add repositories, then `change start`. Every `corvi` command in that recipe carries
`--change <id>`, because the creating session usually belongs to a different change. `corvi change
repository` gives a change its checkouts: `repository list` shows them and the names `remove`
takes; `add <path>` takes `--location new|original`, `--branch change|current|existing` (an
`existing` branch needs `--branch-name <name>`, and a name goes only with `existing`), `--base`,
`--target` and `--force`, and re-sets a path already listed; `remove <name> [--force]` drops one.
Both `create` and `repository` check their arguments before discovery, so a bad flag or missing
argument is `2` whether or not a server is running — as is `--location new` with `--branch
current`, since a new worktree cannot take the branch a source checkout has checked out.

Each group prints its own usage — bare `corvi change`, `corvi action`, or `corvi subagent` — and
the subagent one carries the delegation recipe an orchestrating agent follows. Profile keys are
discoverable (`corvi subagent profile list` answers with what `create` accepts), and the profile
and action files are writable from the command line: `corvi … profile write <id> --scope
global|workspace|repository` (the scope is explicit; a repository file names its checkout with
`--repository <name>`). An agent running in a Corvi terminal is pointed at all of this by the pi and opencode
extensions — a sentence in its prompt, nothing outside Corvi.

The CLI talks to the running server, so with the app closed a control command fails loudly rather
than editing files behind the server's back. It finds the server through `CORVI_URL`, then the
record the server writes at startup (`$XDG_STATE_HOME/corvi/corvi-app-<port>.json`), then the
window's pid-files, then `http://127.0.0.1:4000`. An explicit `--server` or `CORVI_URL` that
answers wins outright; otherwise the server that owns the change is used, and the answer is
ambiguous (`CORVI_URL` names one) only when several servers answer and none or more than one owns
it.

This dispatch is Linux's: no `corvi` is installed on macOS at all. Inside Corvi's own terminals
the CLI is available on both platforms — the server puts its checkout's `apps/cli/bin/corvi` shim
in front of every shell it starts, and it never shadows anything: where a `corvi` already resolves
— the Linux launcher, or another checkout's shim on PATH — that one keeps winning (of several
checkouts' shims, the one already on PATH is the one Corvi terminals use). Anywhere else it is
`bun run cli` in the checkout. A
pane's shell keeps the entry while its startup only prepends to PATH; a shell that replaces PATH
outright loses it, and `corvi` then needs the checkout. `corvi start` and `corvi stop` remain the
Linux launcher's commands. `corvi stop` stops the servers the desktop window recorded in its
pid-files; a dev server (`bun run dev`) records itself for discovery but has no pid-file, so stop
it where it was started.

## Updates

The installed app updates itself from its own checkout. Only when it runs as the installed app,
from a git repository on the remote's default branch — a development server, the browser-fallback
launcher, or a feature branch never sees the feature. On every start, and every two hours after
that, Corvi checks the remote. When a new version is there, the update icon at the bottom of the
navigation column turns yellow and a **New version available** notice appears: click it to open
the update dialog, or click it away — the same version never asks twice.

The dialog lists the commits since the current version, each linking to its page on GitHub, and
**Update now** runs the update — `git pull --ff-only`, `bun install`, and `bun run app:install` —
with a step plan while it runs. Uncommitted changes or unpushed commits in the checkout refuse
the update with the reason in place of the button: Corvi never merges or rebases its own
checkout. A run that stops half way says where it stopped, and **Try again** picks up what is
left. When the steps are done, **Restart now** restarts the app to use the new version — the
terminals (host sessions) survive the restart. The pi and opencode extensions are symlinks into the
checkout and follow the update; see [the manual](terminals.md) for their protocols.

## Browser use

Any browser can open the development server. The page includes a web manifest and icons:

- Safari: File → **Add to Dock**.
- Chrome: use **Install page as app** in the browser menu.

A standalone window uses the full width; a browser tab keeps a readable content column. Localhost
is a secure context for browser APIs and does not require TLS.

## Troubleshooting and development tools

A server that cannot find a built page should report a startup failure. Check the log and run
`bun run build:web` in the correct checkout (the installers and `bun run dev` do it first). A
non-JSON API response can indicate an outdated server; confirm which instance you are using
rather than stopping a process by port.

For screenshots, browser checks, and isolated desktop testing, see [the interface](interface.md#checking-the-interface)
and the contributor [testing guide](../guides/testing.md). Never automate the installed app as a
test fixture.
