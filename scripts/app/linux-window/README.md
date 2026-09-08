# The IWE window on Linux

`iwe-window.py` is the Linux counterpart of the macOS app
(`scripts/app/IWE.swift`): a chromeless native window around the bundled HTTP
server. The engine is **WebKitGTK (libwebkit2gtk-4.1)** driven from Python via
PyGObject — no Electron, no Rust, no second browser, nothing compiled: the
system libraries and Python bindings are enough.

## Run it

```sh
python3 scripts/app/linux-window/iwe-window.py
```

Environment:

| Variable    | Meaning                                                                 |
|-------------|-------------------------------------------------------------------------|
| `IWE_PORT`  | Port the server answers on; default `43117` (matches the macOS app).     |
| `IWE_ROOT`  | Repo root, read for the future launcher/desktop entry; not required.     |
| `IWE_WINDOW_DEBUG` | Set to log the page's console to stdout.                          |

The window does **not** start, stop or supervise the server — that is the
launcher's job (`scripts/app.ts install` on Linux, the Phase 3 task). If
nothing is listening on the port the window says so and keeps watching; when
the server appears it loads it. Closing the window quits the window only.

`test-page.html` exercises the window without the server:

```sh
python3 -m http.server 43117 --directory scripts/app/linux-window/
python3 scripts/app/linux-window/iwe-window.py
```

## What it implements

- 1280×820 window titled "Integrated Work Environment"; `#14161a` behind the
  page from the first frame (window CSS + `set_background_color`, the
  equivalent of the Swift app's `drawsBackground = false`).
- Window title follows the page's `document.title`.
- Application id / WM_CLASS is `iwe` (`GLib.set_prgname` +
  `Gdk.set_program_class`), so a `.desktop` entry with `StartupWMClass=iwe`
  matches it — on Hyprland check with `hyprctl clients`.
- `alert()` / `confirm()` / `prompt()` are drawn as modal dialogs parented to
  the window (WebKitGTK has default dialogs too, unlike WKWebView, which
  silently answered `false` — see the Swift `uiDelegate` story).
- Microphone: `permission-request` is answered with *allow* for same-origin
  user-media requests and `enable-media-stream` is on. This is the WKWebView
  lesson — the voice extension failed inside the macOS embedded view; here the
  permission is explicit, grantable and origin-checked.
- External link activations (`decide-policy`) go to the default browser via
  `xdg-open`; everything else (redirects, same-origin iframes, WebSocket)
  stays in the window.
- No GTK accelerators or menubar, so every keystroke reaches the page — the
  page owns its shortcuts (like the macOS app, whose menu exists only to
  route cmd-C/cmd-V).
- Closing the window (or `window.close()` from the page) quits; the server is
  left to whoever started it.
