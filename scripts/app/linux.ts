/**
 * Installs the Linux app: a desktop entry, an icon and a launcher around the Electron window.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *
 * The window is the built Electron app in `$XDG_DATA_HOME/corvi/app` (scripts/app/electron),
 * launched with the checkout's own Electron. The window manages the server the same way it does
 * on macOS: it starts one of its own — on a fresh port, picked at launch, so what it starts is
 * always its own — and stops it again when the window closes. The pid-file the window writes
 * (one per port) is what `corvi stop` uses to clean up after a window that died harder than it
 * could.
 *
 * Without an Electron binary in the checkout the launcher falls back to the browser's app mode:
 * the launcher starts the server detached and it stays running after the tab closes, because a
 * browser window cannot clean up after anything.
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sh } from "../sh.ts";
import { buildApp } from "./electron/build.ts";
import { ID, PRODUCT, dataDir, stateDir } from "../../src/capabilities/identity.ts";

/** What it is called in the app grid and in its own title bar. */
const NAME = PRODUCT;
/** The window's application id / WM_CLASS — Electron sets both from the app name (scripts/app/electron/main.ts),
 * and StartupWMClass must match. */
const APP_ID = ID;
const root = resolve(".");

const launcherPath = (): string => join(homedir(), ".local", "bin", ID);
const entryPath = (): string => join(homedir(), ".local", "share", "applications", `${ID}.desktop`);
/** Where the built Electron app lives; `$XDG_DATA_HOME` is where an installed program's own
 * files go, and reinstalling refreshes it. */
const appDir = (): string => join(dataDir(), "app");
/** Where the server's output goes ($XDG_STATE_HOME/corvi), next to the pid-files. */
const logDir = (): string => stateDir();

/** The hicolor sizes a PNG icon can fill; the theme scales the nearest one. */
const ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];

const iconPath = (id: string, size: number): string =>
  join(homedir(), ".local", "share", "icons", "hicolor", `${size}x${size}`, "apps", `${id}.png`);

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
      iconPath(APP_ID, size),
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

/** The launcher: installed to ~/.local/bin/corvi, with the repository it serves written in,
 * like `corviRoot` in the app's package.json on macOS — reinstall to point it somewhere else. The
 * port is not written in anywhere: the window picks a fresh one at each launch, so the server
 * behind it is always one that window started. */
const launcher = (): string => `#!/bin/sh
# The Corvi app on Linux: opens the window (an Electron app built from scripts/app/electron),
# which starts a server of its own — on a fresh port, picked at launch, so what it starts is
# always its own — and stops it again when the window closes.
#
#   corvi          open the app
#   corvi stop     stop the servers recorded in the pid-files: ones left
#                    behind only if a window died harder than it could clean
#                    up after
#
# Without an Electron binary this falls back to the browser's app mode, and
# there the server is started detached and outlives the tab — a browser window
# cannot clean up after anything.
#
# Installed by 'bun run app:install'; the repository is written in below.

set -eu

# CORVI_APP_ROOT, not CORVI_ROOT: the server reads CORVI_ROOT as an override for its changes root
# (where per-change directories live — tests set it for exactly that), and the window only
# means "where the code to serve lives". Exporting CORVI_ROOT here would make the app's own server
# scan this repository for changes: an empty overview, and a "Left behind" list offering Delete
# on the worktree's own src/ and node_modules/. The window passes it nowhere — the server is
# started with cd, and reads its changes root from the config file like any other run.
ROOT="\${CORVI_APP_ROOT:-${root}}"
APP="\${XDG_DATA_HOME:-$HOME/.local/share}/${APP_ID}/app"
ELECTRON="$ROOT/node_modules/electron/dist/electron"
STATE="\${XDG_STATE_HOME:-$HOME/.local/state}"
LOG_DIR="$STATE/${APP_ID}"
LOG="$LOG_DIR/log"

# A login shell, because a desktop entry inherits nothing and 'bun' and the
# tokens it needs are exported from the shell's rc file — the same reason the
# macOS app runs the login shell.
SHELL_BIN="\${SHELL:-$(getent passwd "$(id -u)" | cut -d: -f7)}"
SHELL_BIN="\${SHELL_BIN:-/bin/bash}"

answers() {
    curl -s -o /dev/null -m 1 -I "$1"
}

# A port of the kernel's choosing: bind to 0, read, close. Closing the probe
# socket leaves a moment in which another process could take the port, but the
# server binds it back within the second it takes to start, and losing that
# race is visible — the server fails to come up — not silent.
free_port() {
    if command -v python3 >/dev/null 2>&1; then
        PORT=$(python3 -c 'import socket
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])' 2>/dev/null) && [ -n "$PORT" ] && return
    fi
    # No python3: random until curl finds one nothing answers on.
    while :; do
        PORT=$(( 20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 40000 ))
        ! answers "http://127.0.0.1:$PORT/" && return
    done
}

# The server a pid-file wrote down: still there, and actually a Corvi server
# rather than whatever now owns that pid.
ours() {
    [ -n "$1" ] && [ -d "/proc/$1" ] \\
        && tr '\\0' ' ' < "/proc/$1/cmdline" | grep -q "src/server.ts"
}

stop_one() {
    PID=$(cat "$1" 2>/dev/null || true)
    if ! ours "$PID"; then
        rm -f "$1"
        echo "not stopping: pid \${PID:-<none>} in $1 is not a Corvi server (stale pid-file removed)"
        return
    fi
    kill "$PID"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -d "/proc/$PID" ] || break
        sleep 0.5
    done
    if [ -d "/proc/$PID" ]; then
        kill -KILL "$PID" 2>/dev/null || true
    fi
    rm -f "$1"
    echo "stopped: the server $1 recorded (pid $PID)"
}

# One pid-file per port, because two windows run two servers. Stale files are
# removed rather than reported forever.
stop() {
    FOUND=0
    for f in "$LOG_DIR"/corvi-app-*.pid; do
        [ -f "$f" ] || continue
        FOUND=1
        stop_one "$f"
    done
    [ "$FOUND" -eq 1 ] || echo "not stopping: no pid-files in $LOG_DIR — nothing was left running"
}

case "\${1:-start}" in
    stop)
        stop
        exit 0
        ;;
    start)
        ;;
    *)
        echo "usage: corvi [start|stop]"
        exit 64
        ;;
esac

mkdir -p "$LOG_DIR"

# The window is the app: it picks its own fresh port, starts the server on it
# and stops it again when it closes. It is told where the code lives through
# the environment, which a desktop entry alone would not give it.
if [ -x "$ELECTRON" ] && [ -f "$APP/main.cjs" ]; then
    export CORVI_APP_ROOT="$ROOT"
    exec "$ELECTRON" "$APP"
fi

# No Electron: the browser's app mode is the fallback, and a browser window
# cannot start or stop a server — so this launcher does both. Prefer Node's
# TypeScript support; native terminal behavior is verified on Node
# (docs/manual/install.md).
if command -v node >/dev/null 2>&1 && node --experimental-strip-types -e "process.exit(0)" >/dev/null 2>&1; then
    RUNNER="node --experimental-strip-types"
elif command -v bun >/dev/null 2>&1; then
    RUNNER="bun"
else
    echo "the server needs node (22.6+, with type stripping) or bun on PATH — or run 'bun install' in $ROOT for the native Electron window" >&2
    exit 1
fi
free_port
URL="http://127.0.0.1:$PORT/"
: >> "$LOG"
# 'exec' in the shell command makes the pid below the server's own pid, which
# is what makes the pid-file and 'corvi stop' tell the truth.
nohup "$SHELL_BIN" -ilc "cd '$ROOT' && CORVI_PORT='$PORT' NODE_ENV=production exec $RUNNER src/server.ts" >> "$LOG" 2>&1 &
echo $! > "$LOG_DIR/corvi-app-$PORT.pid"
echo "starting the server on port $PORT — logs in $LOG"
for _ in $(seq 1 100); do
    answers "$URL" && break
    sleep 0.1
done
if ! answers "$URL"; then
    echo "the server did not start — see $LOG"
    exit 1
fi
echo "opening in $browser's app mode (run 'bun install' in $ROOT for the native window; the server keeps running after the tab closes — 'corvi stop' stops it)"
exec "$browser" --app="$URL" --class=${APP_ID}
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
  await buildApp(appDir(), root);

  await writeFile(launcherPath(), launcher());
  await chmod(launcherPath(), 0o755);
  await writeFile(entryPath(), desktopEntry());

  const drawn = await icons();

  console.log(`installed: ${entryPath()}`);
  console.log(`  launcher: ${launcherPath()}`);
  console.log(`  window:   ${appDir()}`);
  console.log(`  serves:   ${root} on a fresh port at each launch (bun run dev keeps 4000)`);
  if (!drawn) console.log("  no icon:  install librsvg for one (sudo pacman -S librsvg)");
  console.log("  lifecycle: the window starts its own server and stops it again when it closes — 'corvi stop' cleans up after a window that died harder");
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
  await rm(appDir(), { recursive: true, force: true });
  for (const size of ICON_SIZES) {
    await rm(iconPath(APP_ID, size), { force: true });
  }
  await sh(["gtk-update-icon-cache", "-f", "-t", join(homedir(), ".local", "share", "icons", "hicolor")]);
  // The log dir is left alone: it holds the server's output, which outlives the app.
  console.log(`removed: ${entry}`);
  console.log(`removed: ${launcherPath()}`);
  console.log(`icon removed from hicolor; logs left in ${logDir()}`);
}

export { install, uninstall };
