# node-pty and xterm.js replace ttyd

> **Kind:** decision · **Status:** accepted

## Context

The terminal was [ttyd](https://github.com/tsl0922/ttyd) plus tmux: one detached ttyd process per
change, on its own port, serving ttyd's xterm.js page through a same-origin proxy
(`src/terminals/server/proxy.ts`) with a key-fixing script injected into a page IWE did not own.
The ttyd was started lazily, written down in `terminal.json`, adopted across restarts, cleared
with an anchored `pkill`, and its failures only readable in `/tmp/iwe-ttyd-<id>.log`.

[`electron-host.md`](electron-host.md) parked the alternative ("Still parked: IPC instead of
HTTP, and `node-pty` + xterm.js replacing ttyd") and
[`node-server.md`](node-server.md) put the server on Electron's Node, which made a pty in the
server process natural. The change `investigate-using-node-pty` spiked it; the measurements are
below.

**The spike's decisive result.** node-pty loads under both runtimes, but under Bun 1.4.2 its
`onData` never fires: a pty spawns, exits, and delivers not one byte (an N-API/uv poll gap, not
a build problem — `@lydell/node-pty`'s prebuilt binaries behave identically). Under Node 26 and
under Electron 44's Node (v24.20), spawn, data, resize and exit all work. node-pty 1.1.0 ships
prebuilt addons for darwin-arm64/x64 and win32 only; on Linux the install falls back to
`node-gyp rebuild`, so a compiler is needed there (this machine has one), and node-pty must be
in `trustedDependencies` or Bun never runs its install script.

A two-round comparison against the ttyd stack on this machine (input round trip in the browser,
`seq 1 200000` to its marker, `/api/changes` while the flood's tail renders, RSS) put both stacks
within run-to-run noise — no regression, one fewer process per change (ttyd, ~10 MB); the numbers
are in the change's plan. The round trip is dominated by tmux, the shell and the renderer, not by
the hop ttyd added.

## Decision

**One pty per browser connection runs `tmux new-session -A -s iwe-<id>`, and xterm.js renders it
in the page.** tmux stays, unchanged: it owns sessions, windows, persistence and
`tmux attach -t iwe-<id>`. What ttyd owned is now:

- **the socket bridge** (`src/terminals/server/session.ts`): the route starts the pty before the
  upgrade, so a failure — a missing tmux, the wrong runtime — is an HTTP answer the pane can
  show. Browser-to-server binary frames are keystrokes, text frames are JSON control (resize);
  server-to-browser frames are output. Closing the socket kills the pty; the tmux session
  survives, so reload and restart re-attach with tmux's own redraw.
- **the page** (`src/terminals/client/TerminalPane.tsx`): xterm.js itself, no iframe. The
  terminal is fitted before the socket opens, so the first size the shell sees is the right one;
  a ResizeObserver re-fits and tells the pty. CSI-u keys live in `src/terminals/model.ts`, the
  new-window chord is a callback, the context menu is suppressed on the pane. The renderer is
  WebGL with the default as fallback; scrollback is 0 and the stylesheet hides xterm's empty
  viewport scrollbar.

**The server now runs on Node in development too.** `bun run dev` is `node --watch
src/server.ts`, and the tests spawn their servers with `node`; Node 24+ joins Bun as a
development requirement. The app already ran the server on Electron's Node, so this narrows a
runtime divergence rather than adding one, and it is what makes a single pty implementation
possible. This supersedes the sentence in [`node-server.md`](node-server.md) that Bun stays the
development runtime *for the server*; Bun remains the test runner, the page/extension bundler's
driver, and the toolchain for install scripts.

## Consequences

- `src/terminals/server/proxy.ts` (167 lines), the ttyd half of `tmux.ts` (≈300 lines), the
  `/terminal/:id/*` and `/terminal-keys.js` routes, `terminal.json`, the per-change port and
  log, and the `pkill` are gone. `tmux.ts` is now only tmux commands (windows, prompt, cleanup);
  `stopTerminal` kills the session and the attached ptys exit with it.
- ttyd leaves the README's requirements; `tmux` stays. `node-pty`, `@xterm/xterm` and two addons
  join the runtime dependencies, and `bun install` on Linux compiles the addon (macOS uses the
  shipped prebuild).
- The key script and the same-origin proxy are gone with the iframe: keys, copy/paste, theme,
  font and renderer are app code with types and unit tests (`test/terminal.test.ts` also pins the
  CSI-u mapping). The page's Ctrl+Shift+C/V chords need the Electron host to grant clipboard
  permissions for its own origin (scripts/app/electron/main.ts); a browser grants them itself, or
  asks once.
- `test/clean-test.ts` no longer knows ttyd: a test server is recognised by `--iwe-test-run`
  alone, and the app's server (`electron src/server.ts`) and a dev server (`node src/server.ts`)
  carry no marker.
- Change directories that were active before this decision keep a `terminal.json` (ttyd's pid
  and port). Nothing reads it any more, and nothing needs to: it is inert, and completing the
  change leaves it in the archive with the rest of the directory.
- The terminal shares the server's event loop now. tmux bounds what a terminal can emit (it
  repaints a screen, it does not stream a pipe), and the socket is loopback, so no flow-control
  machinery was added; if a pathological case appears, socket backpressure is the lever.
- The `terminal-flicker` change's complaint is addressed by fit-before-connect plus
  resize-only-on-change; whether anything distinct remains is for that change to say.
- macOS behaviour was verified by hand as before (this machine is Linux); the darwin prebuild is
  the install path there, and the marker is noted here rather than claimed tested.
- Still out of scope: IPC instead of HTTP, replacing tmux, Windows.
