/**
 * The app window's side of the page contract, as a preload script.
 *
 * With `contextIsolation` on (the BrowserWindow's setting, apps/desktop/src/electron/main.ts) the
 * page and the main process share nothing; this bridge is the only door, and it exposes exactly
 * two things: the notification the page asks for, and the callback a notification click calls.
 * The page keeps `openWindow` as the one navigation entry point (apps/web/src/app-root/app.tsx).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { HostPlatform, CorviHost } from "@corvi/web/host";
import { ID } from "@corvi/configuration/node";

// A click can arrive before the page has mounted its handler — a fresh launch, a reload — so the
// click is held until a callback exists. The preload runs before the page's own scripts, which is
// what makes the window the event lands in still the one that will call back.
let open: ((change: string, window: string) => void) | null = null;
let pending: [change: string, window: string] | null = null;

ipcRenderer.on(`${ID}:open-window`, (_event, change: string, window: string) => {
  if (open) open(change, window);
  else pending = [change, window];
});

/** The window's platform for the page's chrome, which only tells macOS apart from the rest
 * (@corvi/web/chrome). Anything else lays out the same way, so it has one name here. */
const platform: HostPlatform =
  process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";

const host: CorviHost = {
  platform,
  notify: (payload) => {
    // Fire and forget: a notification the main process fails to show must not reject into the
    // page's event handler, which is where it would be silently swallowed anyway.
    void ipcRenderer.invoke(`${ID}:notify`, payload);
  },
  setContextMenu: (enabled) => {
    // Fire and forget: a menu the host draws is not something the page waits for.
    ipcRenderer.send(`${ID}:context-menu`, enabled);
  },
  onOpenWindow: (callback) => {
    // Replace, never stack: a page that mounts twice (strict mode in development) must not make
    // one click open the change twice.
    open = callback;
    if (pending) {
      const [change, window] = pending;
      pending = null;
      callback(change, window);
    }
  },
};

contextBridge.exposeInMainWorld("corviHost", host);
