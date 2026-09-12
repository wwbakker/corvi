#!/usr/bin/env python3
"""The IWE window on Linux.

The Linux counterpart of scripts/app/IWE.swift: a chromeless native window
around the bundled HTTP server — no Electron, no Rust, no second browser.
Engine is WebKitGTK (libwebkit2gtk-4.1) driven from Python via PyGObject,
which costs zero compilation and zero code-gen: the bindings exist at
runtime. Like the macOS app, it manages the server it needs: it starts one
of its own — on a fresh port, picked at launch, so what it starts is always
its own and nothing stale on a fixed port can be attached to by mistake —
through the user's login shell (so `bun` and whatever the rc file exports
are there), and a window that closes normally stops the server it started.
The pid-file it leaves in $XDG_STATE_HOME/iwe (one per port) is how
`iwe-app stop` cleans up after a window that died harder than it could
clean up after.

Notifications are the page's, shown by the host: the `iwe`
script-message bridge — the macOS app's protocol, the same
window.webkit.messageHandlers shape — is shown through libnotify, and a
click on a notification comes back into the page as
window.iwe.openWindow(change, windowId).

Launch:

    python3 scripts/app/linux-window/iwe-window.py

or from a .desktop entry. The window's application id / WM_CLASS is "iwe",
so a desktop entry with StartupWMClass=iwe groups and matches it.
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

# WebKitGTK 2.4x+ uses a DMA-BUF renderer that crashes with "Error 71
# (Protocol error)" on some Wayland setups (observed on an RTX 5080 /
# Hyprland machine: the window dies before it appears). Opting out costs a
# little compositing performance but works everywhere. Users whose machines
# take the hardware path can override with WEBKIT_DISABLE_DMABUF_RENDERER=0.
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

# Accelerated compositing on the same machine presents canvas updates a
# frame late: in the terminal, a keystroke's echo only appeared when the
# next one was typed (press A — nothing; press B — A shows). Measured with
# a socket probe: the echo reaches the page in ~1 ms, so the delay is in
# presentation. Without compositing, repaints go straight to the window and
# typing is immediate. The dashboard is mostly static UI, so the performance
# cost is small; override with WEBKIT_DISABLE_COMPOSITING_MODE=0 to test the
# accelerated path.
#
# This is not the whole story for the terminal: in the non-composited path
# the canvas renderers (ttyd's WebGL default, and its 2D canvas fallback)
# are very expensive, so the terminal asks for xterm's DOM renderer instead
# (see terminalPath in src/terminal/server/tmux.ts).
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")

from gi.repository import Gdk, GLib, Gio, Gtk, WebKit2

# libnotify speaks org.freedesktop.Notifications — the one channel every
# notification daemon serves (quickshell, dunst, mako, GNOME, KDE). Its absence
# is not fatal: notifications degrade to the page's own toast (see the
# notifications section).
try:
    gi.require_version("Notify", "0.7")
    from gi.repository import Notify
except (ImportError, ValueError):
    Notify = None

# The page's own background, so the window, the title bar and the gap before
# the first paint are all one colour instead of a white flash — same value as
# the macOS app (NSColor srgb 0x14/0x16/0x1a).
BACKGROUND = "#14161a"
DEFAULT_TITLE = "Integrated Work Environment"


def pick_free_port() -> int:
    """Ask the kernel for a free port on the loopback: bind to 0, read, close.

    A fresh port per launch is the point — the server this window starts is always one this
    window started. Closing the probe socket leaves a moment in which another process could take
    the port; the server binds it back within the second it takes to start, and losing that race
    is visible (the window says the server did not start) rather than silently attaching to a
    stranger. Pin with IWE_PORT to test against a hand-started server.
    """
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


PORT = os.environ.get("IWE_PORT", "").strip() or str(pick_free_port())
URL = f"http://127.0.0.1:{PORT}/"
# Where the code to serve lives. The launcher writes it in (IWE_APP_ROOT — not IWE_ROOT,
# which the server reads as its changes root); without
# it there is nothing to start a server from, and the window only probes.
ROOT = os.environ.get("IWE_APP_ROOT", "").strip()

# Where the server's output and the pid-file go — the same files the launcher
# and `iwe-app stop` use, so every writer agrees on one contract. One pid-file
# per port: two windows run two servers, and `iwe-app stop` stops them all.
def state_dir() -> str:
    return os.path.join(
        os.environ.get("XDG_STATE_HOME", ""), "iwe"
    ) if os.environ.get("XDG_STATE_HOME") else os.path.expanduser("~/.local/state/iwe")


PID_FILE = os.path.join(state_dir(), f"iwe-app-{PORT}.pid")
LOG_FILE = os.path.join(state_dir(), "log")


def show(message: str) -> str:
    """A message page in the app's own colours (mirrors Swift `show(message:)`)."""
    return (
        "<html><head><meta charset='utf-8'></head>"
        "<body style='margin:0;height:100vh;display:flex;align-items:center;"
        "justify-content:center;background:" + BACKGROUND + ";color:#8b93a1;"
        "font:14px ui-sans-serif,system-ui,sans-serif'>"
        f"{message}"
        "</body></html>"
    )


# The event sound canberra resolves through the user's sound theme — the Linux
# analogue of macOS's UNNotificationSound.default, which the host also plays
# itself (the page only says whether there should be one).
SOUND_EVENT = "message-new-instant"


def sound_command() -> list[str] | None:
    """How to play the notification sound here, or None when nothing can.

    The daemons IWE is likely to meet (quickshell, dunst, mako) play no sound
    themselves, so the setting only means anything if the host plays it — the
    macOS host does too. canberra-gtk-play resolves SOUND_EVENT through the
    user's sound theme; paplay on the freedesktop theme's file is the fallback.
    """
    if shutil.which("canberra-gtk-play"):
        return ["canberra-gtk-play", "-i", SOUND_EVENT]
    theme_file = f"/usr/share/sounds/freedesktop/stereo/{SOUND_EVENT}.oga"
    if shutil.which("paplay") and os.path.isfile(theme_file):
        return ["paplay", theme_file]
    return None


class App:
    def __init__(self):
        # Application id (Wayland app_id) and WM_CLASS (X11) — both "iwe" so
        # StartupWMClass=iwe in a .desktop entry matches this window.
        GLib.set_prgname("iwe")
        GLib.set_application_name(DEFAULT_TITLE)
        Gdk.set_program_class("iwe")

        self.window = Gtk.Window(
            title=DEFAULT_TITLE,
            default_width=1280,
            default_height=820,
        )
        # The macOS app centres and remembers its frame; GTK has no
        # frame-autosave, so centre once and let the WM remember.
        self.window.set_position(Gtk.WindowPosition.CENTER)

        # Dark titlebar and dark before-first-paint background. GTK3 honours
        # the gtk-application-prefer-dark-theme hint on servers that theme
        # titlebars (this is what makes the bar match the page instead of
        # sitting on top of it as a grey strip).
        self.settings = Gtk.Settings.get_default()
        self.settings.props.gtk_application_prefer_dark_theme = True
        css = Gtk.CssProvider()
        css.load_from_data(
            b"window, .titlebar { background-color: " + BACKGROUND.encode() + b"; }"
        )
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

        self.web = WebKit2.WebView()
        self.configure_web()
        self.window.add(self.web)

        # The server this window started, if any — the thing that gets stopped
        # when the window goes away. A server already answering on the port
        # belongs to whoever started it and is never touched.
        self.server_pid: int | None = None

        # The window is the app: closing it quits — and stops the server this
        # window started, exactly like applicationWillTerminate on macOS.
        self.window.connect("destroy", self.on_destroy)
        self.web.connect("close", self.on_page_close)
        # The page's title becomes the window title while it is open.
        self.web.connect("notify::title", self.on_title)
        # Links to Jira, GitHub and Azure DevOps belong in the browser, not
        # in this window (same policy as WKWebView decidePolicyFor).
        self.web.connect("decide-policy", self.on_decide_policy)
        # The voice extension needs the microphone: WebKitGTK denies every
        # permission request that no handler answers, so answer user-media
        # requests for our own origin. This is the WKWebView lesson — on
        # macOS the voice extension failed inside the embedded view; here
        # the permission is explicit and grantable.
        self.web.connect("permission-request", self.on_permission_request)
        # WebKitGTK does have built-in script dialogs (WKWebView does not),
        # but we draw our own for determinism — the macOS app learned that
        # confirm() silently returning false is a bad way to behave.
        self.web.connect("script-dialog", self.on_script_dialog)

        # The state the notifications section works with: one libnotify
        # Notification per change and window, so a repeat replaces its banner
        # instead of stacking a second one. (_notices is str → Notification;
        # the annotation is in this comment, not the code, so the line survives
        # libnotify being absent.)
        self._notices = {}
        self._notify_unavailable = False

    # MARK: the web view

    def configure_web(self):
        settings = self.web.get_settings()
        # enable-media-stream gates getUserMedia entirely; without it the
        # microphone never reaches the permission stage at all.
        settings.props.enable_media_stream = True
        settings.props.enable_write_console_messages_to_stdout = bool(
            os.environ.get("IWE_WINDOW_DEBUG")
        )
        # Same-origin iframes (the terminal is one, over WebSocket) work by
        # default; WebSocket needs no setting.

        # The page's way to ask for a notification; the handler is this object
        # (see the notifications section). WKWebView and WebKitGTK expose the
        # same window.webkit.messageHandlers.<name> shape, so the page runs the
        # same delivery code on both platforms.
        content = self.web.get_user_content_manager()
        content.register_script_message_handler("iwe")
        content.connect("script-message-received::iwe", self.on_script_message)

        # Paint our colour from the very first frame, like drawsBackground=false.
        rgba = Gdk.RGBA()
        rgba.parse(BACKGROUND)
        self.web.set_background_color(rgba)

        # Keep the same website data as previous runs (the macOS app uses the
        # default data store): cookies, localStorage, permission decisions.
        # (Default WebContext — nothing ephemeral.)

    # MARK: the server

    def ensure_server(self):
        """Start the server this window owns — the macOS app's start().

        On the fresh port this window picked, nothing answers unless IWE_PORT was pinned; a
        pinned port with a stranger on it is left alone rather than attached to.
        """
        if self._server_answers():
            return  # only possible on a pinned IWE_PORT: someone else's, left alone
        if not ROOT:
            return  # nothing to serve; the probe says so and keeps watching
        os.makedirs(state_dir(), exist_ok=True)
        # A login shell, because a desktop entry inherits nothing and `bun` and
        # the tokens it needs are exported from the shell's rc file — the same
        # reason IWE.swift runs /bin/zsh -ilc.
        shell = os.environ.get("SHELL") or "/bin/bash"
        with open(LOG_FILE, "a") as log:
            process = subprocess.Popen(
                [shell, "-ilc",
                 f"cd '{ROOT}' && IWE_PORT='{PORT}' NODE_ENV=production exec bun src/server.ts"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        self.server_pid = process.pid
        # 'exec' in the shell command makes the pid above the server's own pid,
        # which is what makes the pid-file and `iwe-app stop` tell the truth.
        with open(PID_FILE, "w") as f:
            f.write(str(process.pid))

    def _ours(self, pid: int) -> bool:
        """Still there, and actually an IWE server rather than a recycled pid."""
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                return b"src/server.ts" in f.read().replace(b"\x00", b" ")
        except OSError:
            return False

    def stop_server(self):
        """Stop the server this window started, if it is still ours, and its pid-file.

        The pid-file goes even when the server already died on its own — the window wrote it,
        so the window removes it, rather than leaving `iwe-app stop` a file about nothing.
        """
        pid = self.server_pid
        if pid is None:
            return
        self.server_pid = None
        try:
            os.remove(PID_FILE)
        except OSError:
            pass
        if not self._ours(pid):
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(20):  # five seconds, then the harsh way
            if not os.path.isdir(f"/proc/{pid}"):
                break
            time.sleep(0.25)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    # MARK: window events

    def on_destroy(self, _window):
        # Quitting the window quits the server it started. Terminals are tmux's
        # and survive it, which is the same promise a restart of the server has
        # always made.
        self.stop_server()
        Gtk.main_quit()

    def on_page_close(self, _web):
        # window.close() from JavaScript: closing the window quits.
        self.window.destroy()

    def on_title(self, _web, _pspec):
        title = self.web.get_title()
        self.window.set_title(title or DEFAULT_TITLE)

    # MARK: navigation policy

    def on_decide_policy(self, _web, decision, decision_type):
        # Only link activations can leave the window; everything else
        # (redirects, iframes, WebSocket) is the app talking to itself.
        if decision_type != WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            return False  # let WebKitGTK use its default: allow
        action = decision.get_navigation_action()
        if action.get_navigation_type() != WebKit2.NavigationType.LINK_CLICKED:
            return False
        uri = action.get_request().get_uri()
        host = GLib.Uri.parse(uri, GLib.UriFlags.NONE).get_host() if uri else None
        if host in ("127.0.0.1", "localhost"):
            return False
        # External link: hand to the user's default browser.
        Gio.AppInfo.launch_default_for_uri(uri, None)
        decision.ignore()
        return True

    # MARK: permissions

    def on_permission_request(self, _web, request):
        if isinstance(request, WebKit2.UserMediaPermissionRequest):
            # The requesting origin is not introspectable here (the GIR exports
            # no get_origin on UserMediaPermissionRequest and never has —
            # request.get_origin() raised AttributeError, crashing the handler
            # and denying every request), so judge by the view's own URI: this
            # app only ever loads the loopback origin, and its iframes (the
            # terminal) are same-origin.
            uri = self.web.get_uri() or ""
            if uri.startswith("http://127.0.0.1:") or uri.startswith("http://localhost:"):
                request.allow()
                return True
        request.deny()
        return True

    # MARK: the page's questions
    #
    # A browser draws alert(), confirm() and prompt() itself. WebKitGTK does
    # too (unlike WKWebView, which neither draws nor fails them — the macOS
    # app had to implement all three, see IWE.swift). We draw them here so
    # the behaviour is ours and does not depend on the distro's theme ship.

    def on_script_dialog(self, _web, dialog):
        kind = dialog.get_dialog_type()
        if kind == WebKit2.ScriptDialogType.ALERT:
            self._modal(dialog.get_message(), buttons=Gtk.ButtonsType.OK)
            return True
        if kind in (WebKit2.ScriptDialogType.CONFIRM,
                    WebKit2.ScriptDialogType.BEFORE_UNLOAD_CONFIRM):
            ok = self._modal(dialog.get_message(), buttons=Gtk.ButtonsType.OK_CANCEL)
            dialog.confirm_set_confirmed(ok)
            return True
        if kind == WebKit2.ScriptDialogType.PROMPT:
            text = self._prompt(dialog.get_message(), dialog.prompt_get_default_text())
            dialog.prompt_set_text(text)
            return True
        return False  # anything else: WebKitGTK's default behaviour

    def _modal(self, message: str, buttons) -> bool:
        """Sheet-style dialog parented to the window; returns OK (True/False)."""
        dlg = Gtk.MessageDialog(
            transient_for=self.window,
            modal=True,
            message_type=Gtk.MessageType.QUESTION,
            buttons=buttons,
            text=message,
        )
        response = dlg.run()
        dlg.destroy()
        return response == Gtk.ResponseType.OK

    def _prompt(self, message: str, default: str | None) -> str | None:
        dlg = Gtk.MessageDialog(
            transient_for=self.window,
            modal=True,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.OK_CANCEL,
            text=message,
        )
        field = Gtk.Entry(activates_default=True, width_chars=40)
        field.set_text(default or "")
        field.show()
        dlg.get_content_area().pack_start(field, False, False, 6)
        dlg.set_default_response(Gtk.ResponseType.OK)
        response = dlg.run()
        text = field.get_text()
        dlg.destroy()
        # None → JavaScript null, exactly what a browser's prompt() cancel does.
        return text if response == Gtk.ResponseType.OK else None

    # MARK: notifications
    #
    # The page asks, the host shows — the same contract as IWE.swift: WKWebView
    # has no notification API of its own, and the page prefers the
    # window.webkit.messageHandlers.iwe bridge wherever it exists. Display goes
    # through libnotify rather than GNotification: GNotification needs a
    # GApplication of our own and is presented by the shell, which on
    # Hyprland + quickshell means nowhere, while every daemon serves
    # org.freedesktop.Notifications. A click comes back as the notification's
    # `default` action (the spec's click convention — quickshell invokes it on
    # body click): present the window, then call the page's own
    # window.iwe.openWindow(change, windowId) — the same entry point a
    # notification in a browser uses, so the navigation lives in one place.

    def on_script_message(self, _manager, result):
        try:
            # get_js_value is the introspectable half of WebKitJavascriptResult
            # (webkit2gtk >= 2.40); get_global_context/get_value are not usable
            # from Python. A value that is not JSON simply fails to parse.
            payload = json.loads(result.get_js_value().to_json(0))
        except Exception:
            return  # a notice we cannot read is no notice
        if isinstance(payload, dict) and payload.get("kind") == "notify":
            self._debug(f"notify from page: {payload.get('change')} {payload.get('window')}")
            self.notify(payload)

    def notify(self, body: dict) -> None:
        if Notify is None:
            if not self._notify_unavailable:
                self._notify_unavailable = True
                print(
                    "iwe-window: libnotify's GObject bindings are missing "
                    "(install libnotify) — notifications stay inside the page's toast",
                    file=sys.stderr,
                )
            return
        if not Notify.is_initted():
            Notify.init(GLib.get_prgname() or "iwe")

        title = body.get("title") or DEFAULT_TITLE
        # libnotify has one body string: the change rides as its first line,
        # where the macOS app shows it as the subtitle above the title.
        lines = [line for line in (body.get("subtitle") or "", body.get("body") or "") if line]
        change = body.get("change") or ""
        window_id = body.get("window") or ""

        # A stable identity per change and window — the page sends one — so a
        # repeat replaces the banner it belongs to rather than stacking.
        key = body.get("id") or f"{change}-{window_id}"
        notice = self._notices.get(key)
        if notice is None:
            notice = Notify.Notification.new(title, "\n".join(lines), "iwe")
            notice.set_hint("desktop-entry", GLib.Variant("s", "iwe"))
            # The label is required non-empty (libnotify asserts on "") but is
            # shown only by daemons that draw action buttons — quickshell and
            # GNOME answer the body click instead.
            notice.add_action("default", "Show", self._notice_clicked, change, window_id)
            self._notices[key] = notice
        else:
            notice.update(title, "\n".join(lines), "iwe")

        if body.get("sound"):
            self._play_sound()
        try:
            notice.show()
        except GLib.Error as error:
            print(f"iwe-window: notification failed: {error}", file=sys.stderr)

    def _play_sound(self) -> None:
        command = sound_command()
        if command is None:
            return
        try:
            # Fire and forget: a slow or missing sound server must never hold
            # the notification (or the main loop) up.
            subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            pass

    def _notice_clicked(self, _notification, _action, change, window_id):
        # The same two steps as the macOS delegate: bring the window up, then
        # ask the page to open what the notice was about.
        self._debug(f"notification clicked: {change} {window_id}")
        self.window.present()
        if change and window_id:
            self.open_window(change, window_id)

    def _debug(self, message: str) -> None:
        if os.environ.get("IWE_WINDOW_DEBUG"):
            print(f"iwe-window: {message}", file=sys.stderr)

    def open_window(self, change: str, window_id: str, attempt: int = 0) -> None:
        # Ask the page to open what the notice was about, retrying while it
        # loads: a click can arrive before the page's own window.iwe exists — a
        # fresh launch, a reload. The attempts are a parameter rather than a
        # counter, so the retry closure captures nothing that changes under it.
        def quote(value: str) -> str:
            return value.replace("\\", "\\\\").replace("'", "\\'")

        script = (
            "window.iwe ? (window.iwe.openWindow('%s', '%s'), true) : false"
            % (quote(change), quote(window_id))
        )
        self.web.evaluate_javascript(
            script,
            -1,
            None,
            None,
            None,
            self._open_window_done,
            change,
            window_id,
            attempt,
        )

    def _open_window_done(self, _web, result, change, window_id, attempt):
        opened = False
        try:
            value = self.web.evaluate_javascript_finish(result)
            opened = bool(value and value.to_boolean())
        except GLib.Error:
            pass  # the page navigated under us; the retry will find it
        self._debug(f"openWindow attempt {attempt}: {'ok' if opened else 'retry'}")
        if opened or attempt >= 9:
            return
        GLib.timeout_add(500, self._open_window_retry, change, window_id, attempt + 1)

    def _open_window_retry(self, change, window_id, attempt):
        self.open_window(change, window_id, attempt)
        return False  # one-shot

    # MARK: run

    def run(self):
        self.window.show_all()
        self.ensure_server()
        # A signal is not a window close: without this, `kill` on the window
        # (or a Ctrl-C in whatever terminal started it) would orphan the server
        # it started. GLib's unix signal source is the safe way in — the
        # callback runs on the main loop, not inside the signal itself.
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, self.on_signal)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, self.on_signal)
        self.web.load_html(show(f"Starting IWE…\n\n{URL}"), None)

        self.probes = 0
        GLib.timeout_add(200, self._probe)

        Gtk.main()

    def on_signal(self, *_args) -> bool:
        """A killed window still stops the server it started."""
        self.stop_server()
        Gtk.main_quit()
        return False

    def _probe(self) -> bool:
        """Wait for the server, then load it. Fast at first, then slow."""
        self.probes += 1
        if self._server_answers():
            self.web.load_uri(URL)
            return False
        # The server this window started has died — say so now rather than probing for a minute.
        # It exits itself when the page cannot build, so the log has the reason.
        if self.server_pid is not None and not os.path.isdir(f"/proc/{self.server_pid}"):
            self.web.load_html(
                show(f"The server started and then died — see the log at " + LOG_FILE + "."),
                None,
            )
            GLib.timeout_add_seconds(5, self._reprobe)
            return False
        if self.probes == 300:  # ~60 s: time to say something
            # Say so once, keep a slow re-probe — the server may still come up,
            # and then the window simply becomes the app. The port is this
            # window's own pick, so starting one by hand on it is a way in.
            self._not_started()
            return False
        return True

    def _not_started(self) -> None:
        self.web.load_html(
            show(f"The server did not start — nothing is listening on {URL}."
                 "\n\nSee the log at " + LOG_FILE + ", or start it by hand:\n"
                 f"    IWE_PORT={PORT} bun src/server.ts"),
            None,
        )
        GLib.timeout_add_seconds(5, self._reprobe)

    def _reprobe(self) -> bool:
        if self._server_answers():
            self.web.load_uri(URL)
            return False
        return True

    def _server_answers(self) -> bool:
        try:
            out = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-m", "1", "-I", URL],
                capture_output=True,
                timeout=3,
            )
            return out.returncode == 0
        except Exception:
            return False




def main() -> int:
    app = App()
    app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
