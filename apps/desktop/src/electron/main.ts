/**
 * The Corvi window, in Electron.
 *
 * The page's first row supplies the title bar (docs/manual/interface.md). Electron provides
 * native window controls and hosts the same Chromium page used by browser tests.
 *
 * It is still only a window onto the same HTTP server any browser can open. The app picks a
 * fresh port at each launch, starts the server on it through the user's login shell, and stops
 * the server it started when it quits. A server somebody started themselves — a pinned
 * `CORVI_PORT` answering, `bun run dev` on 4000 — is never touched. The server runs on Electron's
 * own Node (`ELECTRON_RUN_AS_NODE`), not on Bun the user has installed
 * (docs/manual/install.md).
 *
 * Built by apps/desktop/src/electron/build.ts into main.cjs/preload.cjs and run either from a packaged
 * bundle (apps/desktop/src/mac.ts, apps/desktop/src/linux.ts) or straight from the checkout
 * (`bun run app:run`). The checkout to serve is read from the app package.json's `corviRoot`,
 * which is why moving the repository is a reinstall rather than a rebuild.
 */
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRAFFIC_LIGHTS } from "@corvi/web/chrome";
import type { HostNotice } from "@corvi/web/host";
import { ID, PRODUCT, env, stateDir } from "@corvi/configuration/node";

/** The page's own background, so the window, its frame and the gap before the first paint are
 * all one colour instead of a white flash. Same value as the hosts this replaced. */
const BACKGROUND = "#14161a";
/** What this copy is called in the Dock and the title bar until the page names itself. */
const DEFAULT_TITLE = PRODUCT;
/** The event sound canberra resolves through the user's sound theme — the Linux analogue of
 * macOS's default notification sound, which Electron plays itself. */
const SOUND_EVENT = "message-new-instant";

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

/** Where the server's output and, on Linux, the pid-file go — the same files the launcher and
 * `corvi stop` use, so every writer agrees on one contract. */
const logPath = (): string =>
  isMac ? join(homedir(), "Library", "Logs", `${ID}.log`) : join(stateDir(), "log");
const pidFile = (port: number): string => join(stateDir(), `${ID}-app-${port}.pid`);

/**
 * What this copy is called, as Electron found it before the rename below: a packaged bundle's
 * name (a sandbox copy is "Corvi Sandbox", scripts/sandbox.ts) or the app package's. Captured
 * first because it keys the Chromium profile below.
 */
const copyName = app.getName();
/**
 * What this copy is called in the process. `corvi` rather than the product name so Wayland's
 * app_id and X11's WM_CLASS match `StartupWMClass=corvi` in the desktop entry
 * (apps/desktop/src/linux.ts) — the same promise `GLib.set_prgname` + `Gdk.set_program_class` kept
 * for the Python window.
 */
app.setName(ID);
if (isLinux) app.setDesktopName(`${ID}.desktop`);
// Chromium's profile (cache, localStorage, GPU state) has no business in `~/.config/corvi`,
// which holds Corvi's own config.json; give it a directory of its own. The copy's own name is in
// the path, so a sandbox copy does not share the real app's profile — the same separation its
// bundle identifier gives it for notifications and Apple Events. The page's state is per-origin,
// and the origin changes with the fresh port, so nothing here needs to survive a launch.
{
  const profile = copyName && copyName !== ID ? `${PRODUCT} Electron (${copyName})` : `${PRODUCT} Electron`;
  const userData = join(app.getPath("appData"), profile);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

/** The checkout to serve: the app bundle's package.json says where (written at install time,
 * like `IWERoot` in the Swift app's Info.plist); `CORVI_APP_ROOT` overrides it for development. */
const root = (): string => {
  const fromEnv = process.env[env("APP_ROOT")]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
      corviRoot?: string;
    };
    return pkg.corviRoot ?? "";
  } catch {
    return "";
  }
};

/** A fresh port every launch, so the server behind this window is always one this window
 * started: there is nothing stale on a fixed port to attach to by mistake. Bind to 0, read,
 * close — the server binds it back within the second it takes to start, and losing that race is
 * visible (the window says the server did not start) rather than silent. */
const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });

/** One shell-quoted word, for the `cd` in the login-shell command below. */
const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Whether a URL is the app's own page. Everything else is a link to somewhere else. */
const isOursUrl = (url: string): boolean => {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
};

/** `which`, without a dependency: the first executable of that name on PATH. */
const which = (command: string): string | null => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, command);
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * How to play the notification sound on Linux, or null when nothing can. The daemons Corvi is
 * likely to meet (quickshell, dunst, mako) play no sound themselves, so the setting only means
 * anything if the host plays it — canberra resolves the event through the user's sound theme,
 * paplay on the freedesktop theme's file is the fallback. macOS is not asked: its notification
 * carries the sound.
 */
const soundCommand = (): string[] | null => {
  const canberra = which("canberra-gtk-play");
  if (canberra) return [canberra, "-i", SOUND_EVENT];
  const themeFile = `/usr/share/sounds/freedesktop/stereo/${SOUND_EVENT}.oga`;
  const paplay = which("paplay");
  return paplay && existsSync(themeFile) ? [paplay, themeFile] : null;
};

/** Fire and forget: a slow or missing sound server must never hold the notification up. */
const playSound = (): void => {
  const command = soundCommand();
  const [exe, ...args] = command ?? [];
  if (!exe) return;
  try {
    spawn(exe, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // no sound is not a failure
  }
};

const show = (win: BrowserWindow, message: string): void => {
  const html = `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:${BACKGROUND};color:#8b93a1;font:14px ui-sans-serif,system-ui,sans-serif">${message}</body>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
};

/** Nothing is listening when the app opens, so this is only ever the readiness probe for a
 * server this app itself started (or one already answering on a pinned `CORVI_PORT`). */
const answers = async (url: string): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

// --- The server this window started -----------------------------------------

let server: ChildProcess | null = null;
let serverPid: number | null = null;
let stopping = false;

/** The server a pid-file recorded is ours: still there, and actually a Corvi server rather than
 * whatever now owns that pid. macOS has no /proc; there, being alive is as much as this asks,
 * and the pid belongs to a process this window started in the first place. */
const isOurPid = (pid: number): boolean => {
  if (isLinux) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("apps/server/src/server.ts");
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the server this window owns, on the port it picked, and record its pid for
 * `corvi stop`. `exec` in the shell command makes the pid above the server's own pid, which is
 * what makes the pid-file tell the truth. */
const startServer = (port: number, checkout: string): void => {
  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(logPath(), "a");
  // A login shell, because a bundle launched from the Dock or a desktop entry inherits nothing,
  // and the tokens the server uses (`JIRA_API_TOKEN`) are exported from the shell's rc file.
  // `ELECTRON_RUN_AS_NODE=1` makes Electron's own binary the Node that runs the server: it is
  // already on the machine, and it runs the server's TypeScript directly (Node's type
  // stripping), so Bun is no longer part of the app's runtime. The working directory comes from
  // the spawn, not from a `cd` in the command: with nothing before it, `exec` is the shell's
  // whole command, so the pid below is the server's own.
  const loginShell = process.env.SHELL || (isMac ? "/bin/zsh" : "/bin/bash");
  const run =
    `exec env ${env("PORT")}='${port}' NODE_ENV=production ELECTRON_RUN_AS_NODE=1 ` +
    `${shq(process.execPath)} apps/server/src/server.ts`;
  const child = spawn(loginShell, ["-ilc", run], {
    cwd: checkout,
    stdio: ["ignore", log, log],
    detached: true,
  });
  server = child;
  serverPid = child.pid ?? null;
  if (isLinux && serverPid !== null) writeFileSync(pidFile(port), String(serverPid));
};

/** Send a signal to the process group the server leads: the login shell execs the server, so
 * the group is the server — and if a shell ever forks instead, its children go with it. */
const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
};

/** Stop the server this window started, if it is still ours, and its pid-file. The pid-file
 * goes even when the server already died on its own — this window wrote it, so this window
 * removes it, rather than leaving `corvi stop` a file about nothing. */
const stopServer = async (): Promise<void> => {
  const pid = serverPid;
  if (pid === null) return;
  serverPid = null;
  server = null;
  if (isLinux) {
    try {
      unlinkSync(pidFile(port));
    } catch {
      // no pid-file, nothing to remove
    }
  }
  if (!isOurPid(pid)) return;
  signalGroup(pid, "SIGTERM");
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  if (alive(pid)) signalGroup(pid, "SIGKILL");
};

/** Wait for the server to answer, then show the page; a server that never comes up leaves the
 * window saying so rather than showing an empty page. */
const waitForServer = async (win: BrowserWindow, url: string): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (await answers(url)) {
      void win.loadURL(url);
      return;
    }
    await sleep(100);
  }
  show(win, `The server did not start — see ${logPath()}`);
};

// --- Notifications ------------------------------------------------------------

/** One live notification per change and window, so a repeat replaces its banner instead of
 * stacking a second one for the same session. Electron keys that by `id` on macOS and Windows;
 * on Linux the old one is closed by hand. */
const notices = new Map<string, Notification>();

const present = (win: BrowserWindow): void => {
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
};

/** Ask the page to open what the notice was about. A click can arrive while the page is loading,
 * in which case the message waits for `did-finish-load`; a click can also arrive before the page
 * has mounted its handler, which the preload's pending slot covers. */
const openFromNotice = (win: BrowserWindow, change: string, window: string): void => {
  const send = (): void => win.webContents.send(`${ID}:open-window`, change, window);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
};

const notify = (win: BrowserWindow, body: HostNotice): void => {
  if (!Notification.isSupported()) return;
  const change = body.change ?? "";
  const window = body.window ?? "";
  const key = body.id || `${change}-${window}`;
  const options: Electron.NotificationConstructorOptions = {
    title: body.title || DEFAULT_TITLE,
    id: key,
    body: body.body ?? "",
    // Shown even while the app is frontmost; the page has already decided that you are not
    // looking at the window that wants you.
    silent: !body.sound,
  };
  if (isMac) {
    // macOS has a subtitle and a system sound; Linux has neither, so there the change rides as
    // the body's first line and the host plays the sound itself.
    options.subtitle = body.subtitle ?? "";
    options.sound = body.sound ? "default" : undefined;
    options.silent = false;
  } else {
    options.body = [body.subtitle, body.body].filter(Boolean).join("\n");
    options.silent = true;
    if (body.sound) playSound();
  }

  const notice = new Notification(options);
  notices.get(key)?.close();
  notices.set(key, notice);
  notice.on("close", () => {
    if (notices.get(key) === notice) notices.delete(key);
  });
  notice.on("click", () => {
    present(win);
    if (change && window) openFromNotice(win, change, window);
  });
  notice.show();
};

// --- The page's own right-click menu ------------------------------------------

/** Whether the page's setting wants a browser menu on right-click. The setting is in the server's
 * config, which this process does not read, so the page says so (`@corvi/web/host`). Chromium's
 * own menu is not Electron's to draw, so the host draws the handful of things a page needs. */
let contextMenu = true;

/** The menu for where the click landed: the editing roles over a field or a selection, the link out
 * of the app, and the inspector while this runs from a checkout. Nothing to offer means no menu —
 * which is also what a page that handled the click itself gets, since a right-click the page has
 * cancelled never reaches here (the terminal's menu is tmux's, drawn in the grid). */
const menuFor = (
  win: BrowserWindow,
  params: Electron.ContextMenuParams,
): MenuItemConstructorOptions[] => {
  const template: MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    template.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
  } else if (params.selectionText.trim()) {
    template.push({ role: "copy" });
  }
  if (params.linkURL) {
    template.push({
      label: "Open link in browser",
      click: () => void shell.openExternal(params.linkURL),
    });
  }
  if (!app.isPackaged) {
    if (template.length) template.push({ type: "separator" });
    template.push({
      label: "Inspect element",
      click: () => win.webContents.inspectElement(params.x, params.y),
    });
  }
  return template;
};

// --- The window ---------------------------------------------------------------

const buildMenu = (): void => {
  if (isLinux) {
    // No menu, and so no menu accelerators: every keystroke reaches the page, which owns its
    // shortcuts — the same deliberate absence the GTK host had (Ctrl+W/T/N stay the page's).
    Menu.setApplicationMenu(null);
    return;
  }
  // AppKit routed cmd-C, cmd-V and cmd-Q through a menu, and so does Chromium; without one they
  // do nothing. This mirrors the Swift app's menu: only what the system must route.
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [{ role: "hide" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "togglefullscreen" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: BACKGROUND,
    title: DEFAULT_TITLE,
    // No title bar of the platform's: the page's first row is the window's (@corvi/web/chrome,
    // apps/web/src/app-root/styles.css), and macOS keeps its traffic lights, placed where that row expects
    // them. Linux is left as it is — its compositor draws no decorations for this app to remove.
    ...(isMac
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: TRAFFIC_LIGHTS.position }
      : {}),
    webPreferences: {
      // `app.getAppPath()`, not `__dirname`: the bundler (apps/desktop/src/electron/build.ts) writes
      // the source directory into __dirname at build time, and the app does not run from there.
      preload: join(app.getAppPath(), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  // A page that asks to stay (a `beforeunload` handler) must not make the window's close
  // silently do nothing — Electron's default is to honour the page's cancel, and on Wayland the
  // close request then simply has no visible effect. Corvi has no unsaved form, and the hosts
  // this replaced let the unload through; so does this.
  win.webContents.on("will-prevent-unload", (event) => {
    if (process.env[env("WINDOW_DEBUG")]) console.log(`${ID}: the page tried to prevent unload; allowing it`);
    event.preventDefault();
  });

  // Right-click: the page's setting decides whether the menu appears at all.
  win.webContents.on("context-menu", (_event, params) => {
    if (!contextMenu) return;
    const template = menuFor(win, params);
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });

  if (process.env[env("WINDOW_DEBUG")]) {
    win.on("close", () => console.log(`${ID}: window close`));
    win.on("closed", () => console.log(`${ID}: window closed`));
    win.webContents.on("unresponsive", () => console.log(`${ID}: window unresponsive`));
  }
  // The page's title becomes the window title while it is open; Chromium does that by itself.

  // Links to Jira, GitHub and Azure DevOps belong in the browser, not in this window; the page
  // and its same-origin iframes (the terminal) are the only things that stay.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOursUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isOursUrl(url)) return; // the page talking to itself
    event.preventDefault();
    void shell.openExternal(url);
  });

  if (process.env[env("WINDOW_DEBUG")]) {
    // The page's console, where the host that was replaced put it when the variable was set.
    win.webContents.on("console-message", (...args: unknown[]) => {
      const first = args[0];
      const message =
        first && typeof first === "object" && "message" in first
          ? String((first as { message: unknown }).message)
          : String(args[2] ?? "");
      console.log(`${ID}: ${message}`);
    });
  }
  return win;
};

// --- Lifecycle ----------------------------------------------------------------

/** The port this launch picked, or a pinned one from the environment. */
let port = 43117;

const run = async (): Promise<void> => {
  nativeTheme.themeSource = "dark";
  buildMenu();

  const checkout = root();
  const pinned = process.env[env("PORT")] ? Number(process.env[env("PORT")]) : 0;
  port = pinned > 0 ? pinned : await pickFreePort();
  const url = `http://127.0.0.1:${port}/`;

  // The microphone (the voice extension), and nothing else: the page only ever runs from this
  // loopback origin, and a request from anywhere else gets nothing.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.requestingUrl || webContents.getURL();
    // Media is the microphone. The terminal's copy and paste chords go through the page's
    // clipboard API (there is no Linux menu to route them, and Ctrl/Cmd+C belongs to the
    // shell), so the page needs both clipboard permissions. Everything else stays denied.
    const allowed =
      permission === "media" ||
      permission === "clipboard-read" ||
      permission === "clipboard-sanitized-write";
    callback(allowed && isOursUrl(origin));
  });

  ipcMain.on(`${ID}:context-menu`, (_event, enabled) => {
    contextMenu = enabled === true;
  });

  ipcMain.handle(`${ID}:notify`, (event, body) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !body || (body as HostNotice).kind !== "notify") return;
    notify(win, body as HostNotice);
  });

  const win = createWindow();
  show(win, `Starting ${PRODUCT}…`);

  if (pinned > 0 && (await answers(url))) {
    // Only possible on a pinned port: somebody else's server is already here, and it is left
    // alone — never stopped, never attached to on a fresh launch.
    void win.loadURL(url);
    return;
  }
  if (!checkout || !existsSync(join(checkout, "apps", "server", "src", "server.ts"))) {
    show(win, `No ${PRODUCT} checkout to serve — reinstall the app from the repository.`);
    return;
  }
  startServer(port, checkout);
  await waitForServer(win, url);
};

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (serverPid === null || stopping) return;
  // Quitting stops the server this window started; terminals are tmux's and survive it, which is
  // the same promise a restart of the server has always made.
  event.preventDefault();
  stopping = true;
  void stopServer().finally(() => app.quit());
});

void app
  .whenReady()
  .then(run)
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
