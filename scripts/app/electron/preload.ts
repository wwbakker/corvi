/**
 * The app window's side of the page contract, as a preload script.
 *
 * With `contextIsolation` on (the BrowserWindow's setting, scripts/app/electron/main.ts) the
 * page and the main process share nothing; this bridge is the only door, and it exposes exactly
 * two things: the notification the page asks for, and the callback a notification click calls.
 * The page keeps `openWindow` as the one navigation entry point (src/app-root/app.tsx).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { HostPlatform, IweHost } from "../../../src/domain/host.ts";

// A click can arrive before the page has mounted its handler — a fresh launch, a reload — so the
// click is held until a callback exists. The preload runs before the page's own scripts, which is
// what makes the window the event lands in still the one that will call back.
let open: ((change: string, window: string) => void) | null = null;
let pending: [change: string, window: string] | null = null;

ipcRenderer.on("iwe:open-window", (_event, change: string, window: string) => {
  if (open) open(change, window);
  else pending = [change, window];
});

/** The window's platform for the page's chrome, which only tells macOS apart from the rest
 * (src/domain/chrome.ts). Anything else lays out the same way, so it has one name here. */
const platform: HostPlatform =
  process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";

const host: IweHost = {
  platform,
  notify: (payload) => {
    // Fire and forget: a notification the main process fails to show must not reject into the
    // page's event handler, which is where it would be silently swallowed anyway.
    void ipcRenderer.invoke("iwe:notify", payload);
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

contextBridge.exposeInMainWorld("iweHost", host);
