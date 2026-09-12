#!/usr/bin/env python3
"""A bare WebKitGTK window for the rendering probe (scripts/perf.ts).

Deliberately not iwe-window.py: the probe wants one URL, the page's console printed (so ttyd's
"which renderer loaded" line is visible), and then a window that sits there while the
orchestrator samples the processes. The app's own window does far more, and the perf question is
about the engine, not the app's chrome.
"""

import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

url = sys.argv[1]
width = int(os.environ.get("PERF_W", "1600"))
height = int(os.environ.get("PERF_H", "1000"))

# The orchestrator is not always the parent: on Hyprland the compositor starts the window on
# another workspace, so the pid is written down for it to find instead.
pid_file = os.environ.get("PERF_PID_FILE")
if pid_file:
    with open(pid_file, "w") as f:
        f.write(str(os.getpid()))

GLib.set_prgname("iwe-perf")
GLib.set_application_name("IWE perf")

window = Gtk.Window(title="IWE perf")
window.set_default_size(width, height)
view = WebKit2.WebView()
# The renderer ttyd chose is a console line, and this is the only place it is visible.
view.get_settings().props.enable_write_console_messages_to_stdout = True
window.add(view)
window.connect("destroy", Gtk.main_quit)
window.show_all()
view.load_uri(url)
Gtk.main()
