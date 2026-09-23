# Installing and running

## Requirements

- Bun for dependency installation, builds, and development commands.
- Node 24+ for the development server and test servers.
- Git and tmux for repositories and terminals.
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
started development server. tmux sessions survive application/server shutdown.

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
