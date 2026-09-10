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
| `IWE_PORT`  | Pin the port the server answers on; unset, the window picks a fresh one at launch. |
| `IWE_APP_ROOT` | Repo root, telling the window where the code to serve lives; not required. Not `IWE_ROOT`: the server reads that as its changes root. |
| `IWE_WINDOW_DEBUG` | Set to log the page's console to stdout.                          |

The window starts the server it needs — on the fresh port it picked, unless
`IWE_PORT` is pinned — and stops it again when the window closes. The
pid-file it leaves in `~/.local/state/iwe/iwe-app-<port>.pid` is how
`iwe-app stop` cleans up after a window that died harder than it could clean
up after.

`test-page.html` exercises the window without the server:

```sh
IWE_PORT=43117 python3 -m http.server 43117 --directory scripts/app/linux-window/
IWE_PORT=43117 python3 scripts/app/linux-window/iwe-window.py
```

It defines `window.iwe` (so click-through is testable end to end) and reports
in `document.title` — which `hyprctl clients` shows. `?autotest` runs the
capability checks on its own (`bridge=object` is the notification bridge);
`?notify` posts one notification through the bridge, `?notify2` posts a second
while the first toast is still up (exercising replace-not-stack). The dialog
test is skipped in notify modes: a modal `confirm()` suspends the page's JS,
and an `evaluate_javascript` from a notification click would queue behind it.

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
- **Notifications** are the page's, shown by the host — the same contract as
  the macOS app. The `iwe` script-message bridge (the same
  `window.webkit.messageHandlers` shape WKWebView exposes) is registered on the
  view's user-content manager; a `kind: "notify"` message becomes a libnotify
  notification (org.freedesktop.Notifications — the one channel every daemon
  serves: quickshell, dunst, mako, GNOME, KDE). The page's stable id means a
  repeat **replaces** its banner instead of stacking. A click comes back as the
  notification's `default` action: the window presents itself, then the page's
  own `window.iwe.openWindow(change, windowId)` is called, retried while the
  page loads (the macOS `open(_:attempt:)` loop). Sound is played by the host
  through canberra (`message-new-instant` from the user's sound theme;
  `paplay` on the freedesktop theme's file as fallback), because the daemons
  IWE is likely to meet play nothing themselves. libnotify missing degrades to
  the page's own toast.
- External link activations (`decide-policy`) go to the default browser via
  `xdg-open`; everything else (redirects, same-origin iframes, WebSocket)
  stays in the window.
- No GTK accelerators or menubar, so every keystroke reaches the page — the
  page owns its shortcuts (like the macOS app, whose menu exists only to
  route cmd-C/cmd-V).
- Closing the window (or `window.close()` from the page) quits; the server is
  left to whoever started it.

## Notifications, verified on this machine (Arch, Wayland/Hyprland, quickshell)

Driven through `test-page.html` (window on another workspace, clicked via the
shell's notification IPC):

- The bridge exists in the page (`window.webkit.messageHandlers.iwe`), the
  posted message reaches the window, and libnotify shows the banner with the
  app's icon.
- A second notice with the same id **replaces** the first toast in place
  (updated body, one card) — `Notify.Notification.update()` + `show()`.
- Clicking the toast invokes the `default` action → the window presents and
  `window.iwe.openWindow('PROJ-1681', '@7')` runs in the page.
- With `window.iwe` not yet defined, the click retries every 500 ms up to ten
  times and then gives up, like the macOS host.
- `sound: true` plays `message-new-instant` through canberra.

Findings worth keeping: libnotify **asserts a non-empty action label** (an
empty `""` label — the macOS analogue has no label at all — is rejected and
silently drops the action); `WebKitJavascriptResult.get_js_value()` needs
webkit2gtk ≥ 2.40 (older `get_global_context`/`get_value` are not
introspectable); and PyGObject maps `evaluate_javascript` to
`(script, length, world_name, source_uri, cancellable, callback, *user_data)`
— a `None` in the callback slot silently turns the call fire-and-forget,
which is how the retry loop once died without an error.
