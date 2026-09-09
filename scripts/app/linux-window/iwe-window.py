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

Launch:

    python3 scripts/app/linux-window/iwe-window.py

or from a .desktop entry. The window's application id / WM_CLASS is "iwe",
so a desktop entry with StartupWMClass=iwe groups and matches it.
"""

import os
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
# presentation, and both of xterm.js's canvas renderers are affected —
# this is a known shape of WebKitGTK-on-NVIDIA trouble. Without
# compositing, canvas repaints go straight to the window and typing is
# immediate. The dashboard is mostly static UI, so the performance cost is
# small; override with WEBKIT_DISABLE_COMPOSITING_MODE=0 to test the
# accelerated path.
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")

from gi.repository import Gdk, GLib, Gio, Gtk, WebKit2

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
            origin = request.get_origin().to_string()
            if origin.startswith("http://127.0.0.1:") or origin.startswith(
                "http://localhost:"
            ):
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
