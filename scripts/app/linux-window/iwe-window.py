#!/usr/bin/env python3
"""The IWE window on Linux.

The Linux counterpart of scripts/app/IWE.swift: a chromeless native window
around the bundled HTTP server — no Electron, no Rust, no second browser.
Engine is WebKitGTK (libwebkit2gtk-4.1) driven from Python via PyGObject,
which costs zero compilation and zero code-gen: the bindings exist at
runtime. It deliberately does NOT manage the server — starting, stopping
and supervision belong to the Linux launcher (scripts/app.ts install).

Launch:

    python3 scripts/app/linux-window/iwe-window.py

or from a .desktop entry. The window's application id / WM_CLASS is "iwe",
so a desktop entry with StartupWMClass=iwe groups and matches it.
"""

import os
import subprocess
import sys

# WebKitGTK 2.4x+ uses a DMA-BUF renderer that crashes with "Error 71
# (Protocol error)" on some Wayland setups (observed on an RTX 5080 /
# Hyprland machine: the window dies before it appears). Opting out costs a
# little compositing performance but works everywhere. Users whose machines
# take the hardware path can override with WEBKIT_DISABLE_DMABUF_RENDERER=0.
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

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
DEFAULT_PORT = "43117"

PORT = os.environ.get("IWE_PORT", DEFAULT_PORT).strip() or DEFAULT_PORT
URL = f"http://127.0.0.1:{PORT}/"
# Reserved for the future launcher (icon resolution, log paths); the window
# itself only reads it so it is already part of the contract.
ROOT = os.environ.get("IWE_ROOT", "").strip()


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

        # The window is the app: closing it quits, exactly like
        # applicationShouldTerminateAfterLastWindowClosed on macOS.
        self.window.connect("destroy", Gtk.main_quit)
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

    # MARK: window events

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
        # The server is NOT started here — that is the launcher's job
        # (scripts/app.ts install on Linux, matching the macOS split where
        # IWE.swift is the only thing that manages a server). If nothing
        # answers, say so instead of failing silently.
        self.web.load_html(show(f"Starting IWE…\n\n{URL}"), None)

        self.probes = 0
        GLib.timeout_add(200, self._probe)

        Gtk.main()

    def _probe(self) -> bool:
        """Wait for the server, then load it. Fast at first, then slow."""
        self.probes += 1
        if self._server_answers():
            self.web.load_uri(URL)
            return False
        if self.probes == 300:  # ~60 s: time to say something
            # Say so once, keep a slow re-probe — the launcher may still
            # start it, and then the window simply becomes the app.
            self.web.load_html(
                show(f"The server did not start — nothing is listening on {URL}."
                     "\n\nStart it with your login shell, e.g.:\n"
                     f"    IWE_PORT={PORT} bun src/server.ts"),
                None,
            )
            GLib.timeout_add_seconds(5, self._reprobe)
            return False
        return True

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
