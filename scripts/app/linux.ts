/**
 * Installs the Linux app: a desktop entry, an icon and a launcher.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *
 * The window is scripts/app/linux-window/iwe-window.py — a WebKitGTK window
 * onto the server (see docs/native-window.md), with `iwe` as its application
 * id, which is what StartupWMClass matches. The window manages the server the
 * same way the macOS app does: it starts one if nothing is listening (through
 * the user's login shell, so `bun` and whatever ~/.zshrc exports are there)
 * and stops it again when the window closes. A server that was already there
 * belongs to whoever started it and is left alone; the pid-file the window
 * writes is what `iwe-app stop` uses to clean up after a window that died
 * harder than it could clean up after.
 *
 * Without the WebKitGTK bindings the launcher falls back to the browser's app
 * mode, and there the old lifecycle applies: the launcher starts the server
 * detached and it stays running after the tab closes, because a browser window
 * cannot clean up after anything.
 *
 * Nothing is compiled: GTK and WebKit are in the system, Python talks to them
 * through the bindings it already has.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sh } from "../../src/sh.ts";

/** What it is called in the app grid and in its own title bar. */
const NAME = "Integrated Work Environment";
/** The window's application id / WM_CLASS — what scripts/app/linux-window/iwe-window.py sets
 * (GLib.set_prgname + Gdk.set_program_class) and what StartupWMClass must match. */
const APP_ID = "iwe";
/** The app's own port, so it never meets `bun run dev` on 4000 — same as the macOS app. */
const port = process.env.IWE_PORT ?? "43117";
const root = resolve(".");

const launcherPath = (): string => join(homedir(), ".local", "bin", "iwe-app");
const entryPath = (): string => join(homedir(), ".local", "share", "applications", "iwe.desktop");
/** Where the server's output goes ($XDG_STATE_HOME/iwe), next to the pid-file. */
const stateHome = (): string => process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const logDir = (): string => join(stateHome(), "iwe");

/** The hicolor sizes a PNG icon can fill; the theme scales the nearest one. */
const ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];

/** Renders assets/icon.svg into the user's hicolor icons, one PNG per size. Skipped when
 * `rsvg-convert` is missing: an app with a missing icon still works, and refusing to install
 * would be theatre (the macOS install skips its icon the same way). */
async function icons(): Promise<boolean> {
  if (Bun.which("rsvg-convert") === null) return false;
  for (const size of ICON_SIZES) {
    const dir = join(homedir(), ".local", "share", "icons", "hicolor", `${size}x${size}`, "apps");
    await mkdir(dir, { recursive: true });
    const r = await sh([
      "rsvg-convert",
      "-w",
      String(size),
      "-h",
      String(size),
      "assets/icon.svg",
      "-o",
      join(dir, `${APP_ID}.png`),
    ]);
    if (r.code !== 0) {
      console.error(r.stderr || r.stdout);
      return false;
    }
  }
  // Refresh the cache so the icon shows up now; only worth it when the tool is there.
  await sh(["gtk-update-icon-cache", "-f", "-t", join(homedir(), ".local", "share", "icons", "hicolor")]);
  return true;
}

/** The launcher: installed to ~/.local/bin/iwe-app, with the repository it serves written in,
 * like IWERoot and IWEPort in the macOS Info.plist — reinstall to point it somewhere else. */
const launcher = (): string => `#!/bin/sh
# The IWE app on Linux: opens the window (scripts/app/linux-window/iwe-window.py,
# a WebKitGTK window), which starts the server if nothing is listening and stops
# it again when the window closes — the macOS behaviour.
#
#   iwe-app          open the app
#   iwe-app stop     stop the server recorded in the pid-file: the one a window
#                    started, left behind only if that window died harder than
#                    it could clean up after
#
# Without the WebKitGTK bindings this falls back to the browser's app mode, and
# there the server is started detached and outlives the tab — a browser window
# cannot clean up after anything.
#
# Installed by 'bun run app:install'; the repository is written in below.

set -eu

PORT="\${IWE_PORT:-${port}}"
ROOT="\${IWE_ROOT:-${root}}"
WINDOW="$ROOT/scripts/app/linux-window/iwe-window.py"
URL="http://127.0.0.1:$PORT/"
STATE="\${XDG_STATE_HOME:-$HOME/.local/state}"
LOG_DIR="$STATE/iwe"
LOG="$LOG_DIR/log"
PID_FILE="$LOG_DIR/iwe-app.pid"

# A login shell, because a desktop entry inherits nothing and 'bun' and the
# tokens it needs are exported from the shell's rc file — the same reason the
# macOS app runs /bin/zsh -ilc.
SHELL_BIN="\${SHELL:-$(getent passwd "$(id -u)" | cut -d: -f7)}"
SHELL_BIN="\${SHELL_BIN:-/bin/bash}"

answers() {
    curl -s -o /dev/null -m 1 -I "$URL"
}

# The server we wrote down: still there, and actually an IWE server rather
# than whatever now owns that pid.
ours() {
    [ -n "$1" ] && [ -d "/proc/$1" ] \\
        && tr '\\0' ' ' < "/proc/$1/cmdline" | grep -q "src/server.ts"
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "not stopping: no pid-file at $PID_FILE — nothing was left running"
        exit 0
    fi
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if ! ours "$PID"; then
        rm -f "$PID_FILE"
        echo "not stopping: pid \${PID:-<none>} is not an IWE server (stale pid-file removed)"
        exit 0
    fi
    kill "$PID"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -d "/proc/$PID" ] || break
        sleep 0.5
    done
    if [ -d "/proc/$PID" ]; then
        kill -KILL "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "stopped: the server the pid-file recorded (pid $PID)"
}

case "\${1:-start}" in
    stop)
        stop
        exit 0
        ;;
    start)
        ;;
    *)
        echo "usage: iwe-app [start|stop]"
        exit 64
        ;;
esac

mkdir -p "$LOG_DIR"

# The window is the app: it starts the server if nothing is listening and stops
# it again when it closes. It is told where the code lives through the
# environment, which a desktop entry alone would not give it.
if python3 -c 'import gi; gi.require_version("WebKit2", "4.1")' 2>/dev/null; then
    export IWE_ROOT="$ROOT"
    export IWE_PORT="$PORT"
    exec python3 "$WINDOW"
fi

# No WebKitGTK: the browser's app mode is the fallback, and a browser window
# cannot start or stop a server — so this launcher does both, the old way.
for browser in chromium chromium-browser google-chrome google-chrome-stable brave; do
    if command -v "$browser" >/dev/null 2>&1; then
        if answers; then
            echo "server already running on port $PORT — leaving it alone"
        else
            : >> "$LOG"
            # 'exec' so the shell becomes the server and the pid below is its pid.
            nohup "$SHELL_BIN" -ilc "cd '$ROOT' && IWE_PORT='$PORT' NODE_ENV=production exec bun src/server.ts" >> "$LOG" 2>&1 &
            echo $! > "$PID_FILE"
            echo "starting the server — logs in $LOG"
            for _ in $(seq 1 100); do
                answers && break
                sleep 0.1
            done
            if ! answers; then
                echo "the server did not start — see $LOG"
                exit 1
            fi
        fi
        echo "opening in $browser's app mode (install webkit2gtk-4.1 and python-gobject for the native window; the server keeps running after the tab closes — 'iwe-app stop' stops it)"
        exec "$browser" --app="$URL" --class=${APP_ID}
    fi
done
echo "nothing to open the window with — open $URL in your browser"
exit 1
`;

const desktopEntry = (): string => `[Desktop Entry]
Type=Application
Name=${NAME}
Comment=A local dashboard for a change: worktrees, pull requests, tickets and builds
Exec=${launcherPath()}
Icon=${APP_ID}
Terminal=false
Categories=Development;IDE;
StartupWMClass=${APP_ID}
StartupNotify=true
`;

async function install(): Promise<void> {
  await mkdir(join(homedir(), ".local", "bin"), { recursive: true });
  await mkdir(join(homedir(), ".local", "share", "applications"), { recursive: true });
  await mkdir(logDir(), { recursive: true });

  await writeFile(launcherPath(), launcher());
  await chmod(launcherPath(), 0o755);
  await writeFile(entryPath(), desktopEntry());

  const drawn = await icons();

  console.log(`installed: ${entryPath()}`);
  console.log(`  launcher: ${launcherPath()}`);
  console.log(`  serves:   ${root} on port ${port} (bun run dev keeps 4000)`);
  if (!drawn) console.log("  no icon:  install librsvg for one (sudo pacman -S librsvg)");
  console.log("  lifecycle: the window starts the server if needed and stops it again when it closes — 'iwe-app stop' cleans up after a window that died harder");
  console.log("  the app may take a moment to appear in your launcher — the desktop database refreshes on its own");
}

async function uninstall(): Promise<void> {
  const entry = entryPath();
  if (
    !(await Bun.file(entry).exists()) &&
    !(await Bun.file(launcherPath()).exists())
  ) {
    console.log(`not installed: ${entry}`);
    return;
  }
  await rm(entry, { force: true });
  await rm(launcherPath(), { force: true });
  for (const size of ICON_SIZES) {
    await rm(
      join(homedir(), ".local", "share", "icons", "hicolor", `${size}x${size}`, "apps", `${APP_ID}.png`),
      { force: true },
    );
  }
  await sh(["gtk-update-icon-cache", "-f", "-t", join(homedir(), ".local", "share", "icons", "hicolor")]);
  // The log dir is left alone: it holds the server's output, which outlives the app.
  console.log(`removed: ${entry}`);
  console.log(`removed: ${launcherPath()}`);
  console.log(`icon removed from hicolor; logs left in ${logDir()}`);
}

export { install, uninstall };
