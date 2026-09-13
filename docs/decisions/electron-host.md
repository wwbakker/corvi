# Electron is the app's window

> **Kind:** decision · **Status:** accepted

## Context

The app was two hand-written hosts around one HTTP server: Swift/AppKit/WKWebView on macOS
(`scripts/app/IWE.swift`, ~415 lines) and Python/PyGObject/WebKitGTK on Linux
(`scripts/app/linux-window/`, ~651 lines), plus two installers (~520 lines). Each re-implemented
the same list in a different language and toolkit: a free port, the server spawned through a login
shell, quit stops the server, a dark first frame, the page title, external links, script dialogs,
the microphone, notifications with a click-back, Dock/WM_CLASS, pid files.

[`linux-native-window.md`](linux-native-window.md) chose WebKitGTK deliberately — "no Electron, no
second browser" — and rejected QtWebEngine for bundling Chromium. That trade was made against the
alternatives as they stood then. Before changing it, a spike measured what the two hosts cost in
capability and in code: system Electron 39 and 43 on this machine (Arch, Hyprland/Wayland, RTX
5080), against the real server and real ttyd. The full plan and its parity checklist live in the
change (`~/changes/investigate-using-electron/PLAN.md`).

## Decision

**One Electron main process replaces both hosts** (`scripts/app/electron/main.ts`, built by
`scripts/app/electron/build.ts` into a macOS `.app` and, on Linux, an app directory the desktop
entry's `iwe-app` launcher runs). The Bun server and the React page do not move: the window still
loads `http://127.0.0.1:<fresh port>`, any browser remains a first-class view of the same server,
and the extension contract is untouched. The page's way to ask for a notification moved from
`window.webkit.messageHandlers.iwe` to a preload-exposed `window.iweHost`
([`src/domain/host.ts`](../../src/domain/host.ts)), because only a host that owns the notification
can raise the window and play the sound the setting asks for. The Electron counterpart of the
macOS accessibility tooling is Playwright's Electron driver (`bun run app:drive`).

**Why the reversal.** The spike measured, on this machine:

- `chrome://gpu`: Canvas, Compositing, OpenGL, Rasterization and WebGL all hardware accelerated in
  Electron 39 and 43 — where WebKitGTK could only take the software-composited path, which is why
  the Linux window forced xterm's DOM renderer and lived with its documented half-second input
  latency.
- `confirm()` and `alert()` are real Chromium dialogs (driven and accepted through Playwright);
  `prompt()` is unsupported, and the page uses none (0 calls against 6 `confirm`s).
- The real page loads against the real server; the window opens a fresh port and stops its own
  server on quit; notifications show (verified on the session bus); the microphone is granted
  through `setPermissionRequestHandler`; external links open in the browser; ttyd/xterm renders
  and accepts typed input; the window's WM_CLASS is `iwe`.
- The window loads in ~0.2–0.8 s from process start; loopback HTTP is ~1.2 ms per call against
  Electron IPC's ~0.10 ms, both invisible next to the CLI calls that dominate the dashboard.

**What it costs.** Electron's process tree measured ~520–590 MB against WebKitGTK's ~150 MB, and
the app now ships a Chromium — install size, a security cadence, and signing if it is ever
distributed — for one host in one language instead of two hosts in two. The user accepted the
memory and the bundle; the simplicity and the engine parity are the point. Distribution-grade
macOS signing/notarization is out of scope, as it was before.

## Consequences

- `scripts/app/IWE.swift`, `scripts/app/linux-window/`, the JXA `scripts/drive.js`, the
  WebKitGTK renderer override in `src/terminals/server/tmux.ts`, and the WebKitGTK perf harness
  (`scripts/perf/`) are gone. `test/pages.test.ts` is the page suite — Chromium by default,
  `IWE_ENGINE=webkit` for the browser-side check — and the podman harness that forced a WebKit run
  (`Containerfile.webkit`, `bun run test:webkit`) went with the WebKitGTK dependency.
- `bun run app:install` builds the host with `@electron/packager` on macOS, and into
  `~/.local/share/iwe/app` on Linux; Electron 44 downloads its binary lazily, so `app:install`
  fetches it where the error is visible. `bun run app:run` opens the same window straight from the
  checkout, and `bun run app:drive` drives it with Playwright.
- The macOS checklist is verified by hand on a Mac; this machine is Linux and could not check the
  Dock, the title bar, the microphone's usage-description prompt, or notification clicks there.
  Notifications on macOS are accepted as best-effort.
- The server moved to Electron's Node in the same change ([`node-server.md`](node-server.md)):
  the app no longer needs Bun on PATH. Still parked: IPC instead of HTTP. The node-pty/xterm.js
  follow-up is in [`node-pty-terminal.md`](node-pty-terminal.md); tmux stays either way.
