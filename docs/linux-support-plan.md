# Linux Support Plan

**Shipped.** Phases 1, 2, 3 and the tooling part of 4 are done on this branch; README's Linux
section and this doc's status notes are phase 5. The plan below is kept as written, with what
shipped and where reality deviated recorded in "What shipped, and where it deviated" at the end.

What prompted this: the macOS app (a WKWebView) could not support everything — the voice
extension failed silently inside it, and WKWebView has no script dialogs of its own — so the
Linux window had to pick its engine on capability, not dependency counts. That decision is
recorded in `docs/native-window.md`.

IWE is a Bun/TypeScript HTTP server with a web UI; the macOS app is only a window onto it.
Everything under `src/` except the items below already runs on Linux unchanged: the server,
git/gh/az/jira integrations, tmux sessions, config in `~/.config/iwe`, the settings page.

This plan inventories every macOS assumption found in the code and orders the work to remove
them.

## Inventory of macOS-specific code

| Location | What is macOS-only | Linux story |
|---|---|---|
| `scripts/app/IWE.swift`, `scripts/app.ts` | The native app: Swift/WKWebView, `.app` bundle, `swiftc`, `osascript` quit, `iconutil`/`.icns`, `Info.plist`, `open` | New install path: desktop entry + launcher; optional chromeless window via an installed Chromium-based browser's `--app` mode |
| `scripts/app/IWE.swift` (`start()`) | Server started via `/bin/zsh -ilc` (reads `~/.zshrc` for `bun` and `JIRA_API_TOKEN`) | Use the user's login shell from `$SHELL` (`bash -ilc`, `zsh -ilc`, …) |
| `scripts/app/IWE.swift` (`logPath`) | `~/Library/Logs/iwe.log` | `$XDG_STATE_HOME/iwe/log` (`~/.local/state/iwe/log`) |
| `scripts/sandbox.ts` | `.app` copy, PlistBuddy, osascript | Linux: second desktop entry with a different name/port, or just reuse the dev port convention — lower priority |
| `scripts/permissions.ts`, `scripts/drive.js` | TCC screen-recording/accessibility probes, JXA UI driving | No direct equivalent needed to *use* IWE; testing via AT-SPI is a later, optional item |
| `src/terminal.ts` (`--interface lo0`) | macOS loopback interface name | `lo` on Linux — pick by `process.platform` (or pass `127.0.0.1` if ttyd supports a bind address form that is interface-name-free) |
| `src/terminal.ts` (`macOptionClickForcesSelection=true`) | xterm.js macOS-only flag | Harmless elsewhere, but only pass it on macOS; on Linux plain click-drag already selects |
| `src/integrations/git.ts` (`openers`) | `open -a "IntelliJ IDEA"`, `open` (Finder) | Per-OS opener list: `xdg-open` always; IntelliJ via the `idea` launcher script if present; "Open in Files" via `xdg-open` |
| `src/web/TerminalPane.tsx`, `src/terminalProxy.ts` | New-terminal shortcut is `cmd-t` (`e.metaKey`) | Accept `ctrl-alt-t`-style binding on Linux (meta = Super is unreliable in browsers); show the right hint per platform |
| `src/web/CheatSheet.tsx` | `⌥-drag`, `⌘C`, `⌘V`, "Mac clipboard" | Platform-aware key hints: Linux selection is native, copy/paste is `Ctrl+Shift+C/V` in the terminal, browser handles the rest |
| `src/terminal.ts`, `logPath` | `/tmp/iwe-ttyd-*.log` | Fine as-is (or `$XDG_RUNTIME_DIR`), no change needed |
| `scripts/shot.ts`, `test/webkit.test.ts` | WebKit as default engine "because that is what the app is" | Already runs on Linux via Playwright; once the Linux window is Chromium `--app`, default engine choice becomes per-platform |
| `README.md` | "macOS app" framing, `brew install librsvg` | Add a Linux requirements/install section |

Not a problem: `pkill`, `pgrep` (procps), `tmux`, `ttyd`, `git`, `gh`, `az`, Bun itself — all
available on Linux. The `wt` CLI is a user-supplied tool on PATH either way.

## Design decision: what "the app" is on Linux

> **Superseded by `docs/native-window.md`.** The order below was the plan; the decision went the
> other way. Kept for the record.

The macOS app's philosophy is deliberate: **no Electron, no Rust, no second browser — a window
onto the same HTTP server any browser can open**. The Linux equivalent, in order of preference:

1. **Launcher (baseline, required).** A `.desktop` entry that starts the server if nothing is
   listening on the app port and then opens the window (see 2) or, failing that, the default
   browser. This is `scripts/app.ts install` for Linux.
2. **Chromeless window via the browser you already have (recommended).** Every
   Chromium-based browser (`google-chrome`, `chromium`, `brave`, `edge`, …) supports
   `--app=http://127.0.0.1:43117/`, which draws the page with no tabs, no omnibox, its own taskbar
   entry. This is the closest thing to the WKWebView window and costs zero new dependencies or
   toolchains. Firefox has no equivalent, so: detect a Chromium browser, fall back to
   `xdg-open` in a normal tab.
3. **WebKitGTK window (optional, later).** A faithful native window is possible with
   WebKit2GTK via a tiny Vala or Python/PyGObject wrapper compiled at install time (same
   "compile at install, nothing at runtime" trade as the Swift app). Only worth it if `--app`
   mode disappoints — it brings a dependency on `libwebkit2gtk-4.1` and a second rendering
   engine to keep tested against. Defer.

## Work items, in order

### Phase 1 — server correctness on Linux (no UI change) — **shipped** (1e40d69)

1. New `src/platform.ts`: `isMac`, `isLinux`, and platform-picked helpers, so the `if`s live in
   one place.
2. `src/terminal.ts`: `lo0` → `lo` on Linux (bind address per platform); pass
   `macOptionClickForcesSelection` only on macOS.
3. `src/integrations/git.ts`: `openers` becomes a function of platform, with existence checks —
   `xdg-open`, `idea` (only if on PATH), Finder/Finder-equivalent label per OS.
4. Any shell assumptions: nothing in `src/` hardcodes zsh (the Swift app does); fixed in Phase 3.
5. Verify `bun run test` green on Linux (the suite shells out heavily; this is the real gate).
   Fix anything that falls out — likely nothing, but `test/webkit.test.ts` may need
   `bunx playwright install webkit` documented for Linux distro differences.

### Phase 2 — web UI parity — **shipped** (fdefac0)

1. Send `platform` (from `process.platform`) to the client once — via `/api/settings` or a small
   `/api/bootstrap` — instead of sniffing the user agent.
2. Terminal shortcut: on Linux accept `meta-t` *and* a Linux-natural alternative
   (`ctrl-alt-t`); `src/web/TerminalPane.tsx` and `src/terminalProxy.ts` share the handler, so
   one helper covers both. Update the `title` tooltip in `Sidebar.tsx`.
3. `CheatSheet.tsx`: per-platform key table (macOS keeps the current rows; Linux gets
   "drag to select", `Ctrl+Shift+C/V`, middle-click paste note).

### Phase 3 — the Linux app — **shipped** (f4c77dd, bdb70d0), with deviations recorded below

1. Split `scripts/app.ts`: keep macOS logic in `scripts/app/macos.ts`; add
   `scripts/app/linux.ts`; `scripts/app.ts` dispatches on `process.platform`.
2. Linux install (`bun run app:install` on Linux):
   - `~/.local/share/applications/iwe.desktop` (Name, Exec, Icon, `StartupWMClass` so the
     `--app` window groups under its own icon);
   - PNG icons into `~/.local/share/icons/hicolor/<size>/apps/iwe.png`, rendered from
     `assets/icon.svg` with `rsvg-convert` (already a soft dependency for the macOS icon);
     fall back to a single 512px icon when it is missing, same spirit as the macOS icon path;
   - the launcher executable: checks the app port (`HEAD http://127.0.0.1:43117/`), starts
     `bun src/server.ts` under the user's login shell if silent (same semantics as the Swift
     `start()` — `NODE_ENV=production`, logs to `$XDG_STATE_HOME/iwe/log`), then
     `--app`-opens the window; quit behaviour = close the window (server keeps running, like a
     dev server — or kill it if the launcher started it; match the macOS promise: the app stops
     the server *it* started);
   - uninstall removes all three.
3. `scripts/app.ts` Linux messages replace the `drag it to the Dock` copy with the desktop-entry
   equivalent.
4. Optional later: WebKitGTK wrapper (see decision above) as `scripts/app/linux-window/`.

### Phase 4 — dev/test tooling parity — **item 1 shipped**; items 2–3 unchanged (macOS-only, later)

1. `scripts/shot.ts`: default engine per platform once the Linux window is Chromium-based
   (`--app` ⇒ chromium); explicit `IWE_ENGINE` still wins.
2. `scripts/permissions.ts` / `scripts/drive.js`: macOS-only, keep and say so; a Linux
   end-to-end driver (AT-SPI via `python3-atspi`, or `xdotool`/`ydotool` on Wayland) is a
   separate, optional follow-up — Playwright already covers the page itself.
3. `scripts/sandbox.ts`: leave macOS-only for now; note it in `--help`/README.

### Phase 5 — docs and packaging — **item 1 shipped** (README Linux section); item 2 still on demand

1. README: Requirements section per OS (identical CLI list; add
   `xdg-open` is a given, `rsvg-convert` optional for icons); a Linux install paragraph;
   `brew install librsvg` → per-distro hint.
2. Later, on demand: AUR PKGBUILD or generic tarball with a `make install` that does the
   desktop-entry step; Flatpak only if users ask (it sandboxes the terminal, which fights the
   tmux/ttyd design).

## Open questions

- **App-port lifecycle on Linux**: the macOS app kills the server it started on quit. With an
  `--app` window the "app" is the browser process; propose the launcher writes its own pid-file
  next to the port note and the window-close path (a small `beforeunload`/extension of the
  server's shutdown) offers to stop it. Simplest v1: launcher leaves the server running — the
  same behaviour as closing the browser tab on a dev server — and documents it.
- **`wt` on Linux**: confirm the worktree CLI the repo depends on exists for Linux and behaves
  the same; if it is a personal tool, that becomes a documentation item rather than code.
- **Voice extension**: the macOS `NSMicrophoneUsageDescription` exists because the terminal is
  spawned by the app. Under `--app` the permission belongs to the browser, which already has
  one — likely a non-issue, verify once.
- **Wayland vs X11**: only affects the optional AT-SPI driving and the exact `--app` flags
  (`--ozone-platform-hint=auto`); core functionality is unaffected.

## What shipped, and where it deviated

**The window decision was reversed, deliberately.** The plan ranked the Chromium `--app` window
second (recommended) and WebKitGTK third (deferred). Evaluating the candidates against the
WKWebView lesson — the voice extension that failed silently, dialogs that answered `false` —
flipped the order: WebKitGTK handles both as deliberate API (`permission-request` grantable per
origin, `script-dialog` with its own or the app's dialogs), it costs zero compile via
PyGObject, and on a stock desktop it is already installed. `docs/native-window.md` has the
comparison. Chromium `--app` is demoted to the documented fallback the launcher uses when the
WebKitGTK bindings are missing.

**The app is not compiled at all.** The plan pictured "a tiny Vala or Python/PyGObject wrapper
compiled at install time". Vala bought a compiler and a second language for an identical engine;
PyGObject's bindings are generated at runtime, so even the install-time compile of the plan
disappeared — `scripts/app/linux-window/iwe-window.py` is run where it sits.

**macOS logic stayed in `scripts/app.ts`.** The plan split it into `scripts/app/macos.ts` with
`app.ts` dispatching; the split proved to be one `if` on `src/platform.ts` with the Linux half in
`scripts/app/linux.ts`, and the macOS flow untouched inside `app.ts` — a smaller diff for the
same dispatch.

**The lifecycle question was decided, not left open.** Closing the window leaves the server
running (v1, as the open question proposed); the launcher writes the server's pid to
`~/.local/state/iwe/iwe-app.pid` and `iwe-app stop` stops exactly that server — refusing a pid
that is no longer an IWE server — which is more than the plan's "documents it".

**Icons skip instead of falling back.** The plan suggested a single 512px icon when
`rsvg-convert` is missing; the install skips icons with a clear message instead, matching the
macOS install's "an app with the wrong icon still works".

**`wt` was settled by measurement, not porting.** `docs/wt-on-linux.md` verified every
invocation IWE makes against Worktrunk on Linux — identical behaviour, `sudo pacman -S
worktrunk` — so nothing in the integration changed and the version requirement is "any current
package".

**The terminal chord is `ctrl-alt-t` on Linux** (with cmd-t kept on macOS), served to the client
via the server's platform rather than user-agent sniffing — as the plan's Phase 2 sketched.

**Still open, unchanged:** the Linux end-to-end driver (AT-SPI/xdotool) and `scripts/sandbox.ts`
stay macOS-only follow-ups; AUR/Flatpak packaging waits for demand.
