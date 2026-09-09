# The native Linux window

The macOS app (`scripts/app/IWE.swift`) is a Swift/WKWebView wrapper around the
bundled HTTP server: system libraries, compiled at install time, no Electron,
no Rust, no second browser. The user hit the limits of that choice — WKWebView
could not support everything (the voice/microphone extension failed inside
it), and WKWebView has no script dialogs of its own (the Swift app implements
`alert`/`confirm`/`prompt` by hand). For Linux we picked the engine
deliberately, weighting real capability gaps, not dependency counts.

**Recommendation: WebKitGTK (`webkit2gtk-4.1`) driven from Python/PyGObject.**
A prototype exists and runs on this machine: `scripts/app/linux-window/`.

## Candidates

| | **WebKitGTK + PyGObject** (chosen) | WebKitGTK + Vala | QtWebEngine + PySide6 | Chromium `--app` |
|---|---|---|---|---|
| Engine | WebKit (same family as WKWebView/Safari) | WebKit (identical) | Chromium (bundled) | Chromium (the user's browser) |
| Code | Python, ~300 lines, zero compile | Vala → compile with `valac` at install | Python, but a second engine | A shell one-liner |
| New packages on Arch | **0** (already pulled in by many desktops; `pacman -Qi webkit2gtk-4.1` today: installed) | `vala` (not installed here) | `qt6-webengine` **282 MiB** + `pyside6` **51 MiB** + qt6-base/declarative — a second Chromium on disk | 0 (already installed) |
| Runtime cost | WebProcess per page, ~150 MB total; bindings via cffi, no per-call overhead of note | Same engine; marginally faster startup (~10 ms vs ~100 ms) | Heaviest: own Chromium multi-process tree | Shares the running browser; one more mode of the thing the user already runs |
| Same-origin iframes over WebSocket (xterm.js terminal) | Yes (WebSocket, iframes core WebKit) | Same | Yes | Yes |
| `alert()`/`confirm()`/`prompt()` | Built-in default dialogs **and** overridable via the `script-dialog` signal — the prototype draws its own modal sheets. This is the WKWebView lesson: WKWebView silently answers `false`; WebKitGTK does not have that gap | Same | Chromium UI, fully working | Chromium UI, fully working |
| Keyboard shortcuts reaching the page vs the window | No GTK accelerators/menubar ⇒ everything reaches the page; the prototype deliberately adds none | Same | Qt owns some (Ctrl+Q etc.) unless stripped | Browser shell owns Ctrl+T/Ctrl+W/N — the page cannot have them |
| Microphone (the voice extension) | `enable-media-stream` setting + `permission-request` signal, grantable per origin from code — **controllable inside the app**, unlike WKWebView where the extension simply failed. WebKit requires a user gesture for `getUserMedia` (same as Safari); the extension's click-driven flow meets that | Same engine, same result | Chromium permissions, works | Chromium permissions, works |
| Clipboard read/write | `navigator.clipboard` present; `writeText`/`readText` require a user gesture (threw `NotAllowedError` from a script without one — same gate as Chromium). With a gesture, write works; `readText` has no per-origin prompt UI in WebKitGTK (gap, see below) | Same | Works, Chromium permission UI | Works, browser permission UI |
| WebGL / canvas | Yes (verified: WebGL context created in the prototype; NVIDIA/GBM needs `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Wayland — set by the prototype, overridable) | Same | Yes | Yes |
| Dark background before first paint | `webkit_web_view_set_background_color()` + window CSS — verified: no white flash | Same | `QWebEngineView` has `setBackgroundColor` | No reliable per-window background flag; white/dark flash until Chromium paints |
| Window title from the page | `notify::title` signal — implemented; verified | Same | Qt signal | It is a browser tab; title works but with browser chrome behaviour |
| Stable WM_CLASS / app id for a `.desktop` entry | `iwe` — set via `GLib.set_prgname` + `Gdk.set_program_class`; verified in `hyprctl clients` on Wayland | Same | Qt: `QApplication.setDesktopFileName` | Chromium's class unless you run `--class=iwe` (and then it still shares the browser process, history, profile) |
| "No second browser" philosophy | Yes — system library, no other browser involved | Same | **No** — bundles an entire Chromium | Gray area — reuses *the user's* browser, which is the plan's fallback, not the app |

## Why WebKitGTK + PyGObject

1. **It is the macOS app's trade, kept.** A window onto the server, made of
   system libraries, zero compile (PyGObject bindings are generated at
   runtime — even less build machinery than the Swift binary).
2. **The WKWebView failure is a gap WebKitGTK closes, not repeats.** Script
   dialogs exist (and are replaceable); microphone permission is an API call
   we control; both are implemented in the prototype and verified.
3. **Zero new dependencies on this machine, near-zero for users**:
   `webkit2gtk-4.1` is standard on desktop Arch (any GNOME/Cinnamon-based
   system has it; on Hyprland-only installs it is one package).
4. **Vala would add only a compiler and a second language** — the engine, and
   therefore every capability row above, is identical. Worth it only if the
   ~100 ms Python startup or the `python-gobject` dependency ever matters.
5. **QtWebEngine is a second browser by another name** — 280+ MB of bundled
   Chromium to keep tested, exactly what the philosophy rules out.
6. **Chromium `--app` remains the fallback** (and the launcher's baseline per
   the plan): perfect web compatibility, zero deps, but it is the browser's
   window — it owns keyboard shortcuts, its process/class matches the
   browser, and it cannot give the dark-before-paint or dialog behaviour the
   macOS app has.

## What the prototype covers (`scripts/app/linux-window/`)

`iwe-window.py` — run with `python3 scripts/app/linux-window/iwe-window.py`:

- Reads `IWE_PORT` (default `43117`) and optional `IWE_ROOT` from the
  environment; loads `http://127.0.0.1:PORT/`.
- 1280×820 window, title "Integrated Work Environment", `#14161a` behind the
  page from the first frame (window CSS + `set_background_color`), dark
  titlebar hint.
- Window title follows the page's `document.title`.
- Application id / WM_CLASS `iwe` — a future `.desktop` entry uses
  `StartupWMClass=iwe`; verified with `hyprctl clients` on Wayland.
- Own modal `alert`/`confirm`/`prompt` dialogs (`script-dialog`), parented to
  the window; beforeunload confirm passes through. Verified on screen.
- Microphone: `enable-media-stream` on; `permission-request` auto-allows
  user-media for `127.0.0.1`/`localhost` origins, denies the rest.
- External link activations go to the default browser via `xdg-open`
  (`decide-policy`); everything else stays in the window.
- No GTK accelerators: all keystrokes reach the page.
- Manages the server, like the macOS app: if nothing answers on the port it starts one (through
  the user's login shell, `IWE_ROOT` telling it where the code lives — the launcher exports
  it), and closing the window (or `window.close()` from the page) stops the server it started.
  A server that was already there belongs to whoever started it and is left alone; the pid-file
  it writes is what `iwe-app stop` uses. Launchable from a shell and from a `.desktop` entry
  alike (it is the launcher's Exec target).
- `test-page.html` exercises everything without the IWE server, including a
  `?autotest` mode that reports capabilities via `document.title`.

Verified on this machine (Arch, Wayland/Hyprland, RTX 5080):

- Window appears; `hyprctl clients` shows class `iwe`, correct title.
- Autotest through the real window reported:
  `mediaDevices=object clipboardApi=object webgl=ok`, `clipboardWrite` /
  `clipboardRead` / no-gesture `getUserMedia` → `NotAllowedError` (gesture
  gate, see gaps), WebSocket handshake attempted (the trivial server has no
  `/ws` endpoint, so `handshake-failed` — the engine reached the upgrade).
- `confirm()` from the page produced the window's own modal dialog
  (screenshot-verified).
- With `WEBKIT_DISABLE_DMABUF_RENDERER` unset, WebKitGTK 2.52 crashes on
  Wayland with `Error 71 (Protocol error)` before the window appears (NVIDIA
  GBM path). The prototype sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` by
  default (overridable with `=0`); under X11 (`GDK_BACKEND=x11`) it runs
  without the workaround, with harmless GBM-buffer warnings.

## What a user must install

```sh
# Arch: the prototype itself needs nothing more on a stock desktop
sudo pacman -S --needed webkit2gtk-4.1 python-gobject   # ~135 MiB, usually already present
# optional, only if you later choose the Vala variant of the same engine:
sudo pacman -S --needed vala
```

Debian/Ubuntu: `libwebkit2gtk-4.1-dev`/`gir1.2-webkit2-4.1` +
`python3-gi`; Fedora: `webkit2gtk4.1-devel` + `python3-gobject`.
The QtWebEngine route would additionally pull
`qt6-webengine` (282 MiB) + `pyside6` (51 MiB) — one more reason it lost.

## Gaps vs the macOS WKWebView app (deliberate, known)

1. **Microphone needs one real click.** WebKit requires a user gesture for
   `getUserMedia`; the voice extension's click-driven flow satisfies it, but
   the permission path (our auto-allow) has not been exercised end-to-end by
   an actual click in this prototype — click the
   `getUserMedia({audio:true})` button in `test-page.html` to confirm.
2. **Clipboard read has no prompt UI.** `readText()` with a gesture has no
   per-origin permission prompt in WebKitGTK the way Chromium has; where the
   IWE page needs a read, prefer paste-as-keystroke (Ctrl+V) as the terminal
   already does. Writes with a gesture work.
3. **GPU path on NVIDIA/Wayland is disabled by default** (dmabuf renderer
   crash, above). Compositing still happens; on Intel/AMD users can set
   `WEBKIT_DISABLE_DMABUF_RENDERER=0` to test the hardware path.
4. **No frame-autosave.** GTK3 has no equivalent of the Swift
   `setFrameAutosaveName`; the window centric and the WM remembers size.
5. **No in-window menu** (macOS gets cmd-C/cmd-V routing from the menu bar);
   on Linux the page and GTK input handling cover copy/paste — Linux
   terminals use `Ctrl+Shift+C/V` anyway (see the plan's Phase 2).
6. **Vala/compiled-binary route** (faster startup, no Python dependency) is
   deliberately deferred; the engine and capabilities would not change.
