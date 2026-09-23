/**
 * The host capability: what the page asks the window for, and what the window calls back.
 *
 * The page runs in two kinds of place — the app's own window (Electron, docs/manual/install.md)
 * and a real browser. Only the app has a host: it shows the notification the page asks for, and
 * answers a click by asking the page to open the change and tmux window the notice was about. A
 * browser has no bridge, so the page falls back to the browser's own `Notification`
 * (apps/web/src/app-root/notify.tsx), which is the same entry point a click uses.
 *
 * This file is the vocabulary both sides speak; the transport is the preload's
 * `contextBridge` (`window.corviHost`, apps/desktop/src/electron/preload.ts), and nothing here runs.
 */

/** One window that has started wanting the user, in the shape the host shows it. */
export type HostNotice = {
  /** The page only ever asks for notifications; the host ignores anything else. */
  kind: "notify";
  /** Stable per change and window: a repeat replaces its banner instead of stacking a second. */
  id: string;
  /** What the window is called: the session's name when it has one. */
  title: string;
  /** The change's name — the subtitle on macOS, the body's first line where there is no subtitle. */
  subtitle: string;
  /** The presenter's own words, e.g. the first sentence of the agent's last answer. */
  body: string;
  /** Whether the host should play the notification sound; the settings file decides. */
  sound: boolean;
  /** The change the window belongs to. */
  change: string;
  /** tmux's window id — stable across reordering, unlike the index. */
  window: string;
};

/** The platforms the page's chrome has to tell apart: macOS keeps its traffic lights in the
 * page's own top row, the others draw nothing there (apps/web/src/domain/chrome.ts). */
export type HostPlatform = "darwin" | "linux" | "win32";

/** The app window's side of the contract, exposed to the page as `window.corviHost`. */
export type CorviHost = {
  /** The window's platform, read synchronously: the page lays its chrome out before the first
   * paint, and the server's own answer (the terminal's key hints) is a fetch later. */
  platform: HostPlatform;
  /** Show a notification. The host decides how; today that is Electron's `Notification`. */
  notify: (payload: HostNotice) => void;
  /** Register the click-back, called after a notification click raises the window. The page
   * registers once, on mount, so its handler exists before any notice can arrive. */
  onOpenWindow: (callback: (change: string, window: string) => void) => void;
  /** Whether right-clicking should show the browser's own menu. The setting lives in the server's
   * config, which the host does not read, so the page it is showing says so — on mount and whenever
   * it changes. */
  setContextMenu: (enabled: boolean) => void;
};
