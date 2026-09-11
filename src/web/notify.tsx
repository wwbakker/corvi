import { type JSX, useCallback, useRef, useState } from "react";
import { useServerEvent } from "./events.ts";
import type { TerminalWindow } from "../terminalTypes.ts";

/**
 * What a window wanting you turns into: a native notification in the app's window, the browser's
 * own where there is no host, and a toast in the page either way.
 *
 * The server does the detecting — it already reads `@agent` from tmux every tick — and says what
 * happened on the `notify` event. The page does the deciding, because only the page knows what is
 * on screen; and the host does the showing, because WKWebView has no notification API of its own.
 */

declare global {
  interface Window {
    /** The host's way back in: a notification click activates the window, then calls this to
     * open the change and the tmux window it was about. Registered by `App` on mount. */
    iwe: { openWindow: (change: string, windowId: string) => void };
  }
}

/** The server's `notify` payload: one window that has started wanting the user. */
export type Notice = {
  /** The change the window belongs to. */
  change: string;
  /** tmux's window id — stable across reordering, unlike the index. */
  window: string;
  /** What the window is called: the session's name when it has one. */
  label: string;
  /** The presenter's own words, e.g. the first sentence of the agent's last answer. */
  note?: string;
  /** Whether the host should play a sound; the settings file decides. */
  sound: boolean;
};

/** The suppression rule, pure so it can be pinned: notify unless you are actually looking at the
 * window that wants you — its change, its terminals page, that window, and a document that is
 * visible and focused. Backgrounded, minimized, another change or another page: notify. */
export const shouldNotify = (looking: {
  viewing: boolean;
  visible: boolean;
  focused: boolean;
}): boolean => !(looking.viewing && looking.visible && looking.focused);

/** The notification's words: the session's name, and what it said (or that it is waiting). */
export const noticeText = (notice: Notice): { title: string; body: string } => ({
  title: notice.label,
  body: notice.note?.trim() || "waiting for you",
});

type Bridge = { postMessage: (message: unknown) => void };

/** Whether this page has the keyboard. The terminal focuses its own iframe, and focusing a
 * frame still means the page around it is the one you are looking at. */
const pageFocused = (): boolean =>
  document.hasFocus() || document.activeElement?.tagName === "IFRAME";

const bridgeOf = (): Bridge | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { iwe?: Bridge } } }).webkit
    ?.messageHandlers?.iwe;

/** Show it where it can be shown. The host bridge is the app windows (WKWebView and WebKitGTK,
 * the same shape); the browser's Notification is for a page in a real browser; and no path is an
 * error, because the toast is always there. */
function deliver(notice: Notice, text: { title: string; body: string }, onOpen: () => void): void {
  const bridge = bridgeOf();
  if (bridge) {
    bridge.postMessage({
      kind: "notify",
      id: `${notice.change}-${notice.window}`,
      title: text.title,
      subtitle: notice.change,
      body: text.body,
      sound: notice.sound,
      change: notice.change,
      window: notice.window,
    });
    return;
  }
  if (typeof Notification === "undefined") return;
  const show = (): void => {
    const shown = new Notification(text.title, {
      body: text.body,
      tag: `${notice.change}-${notice.window}`,
    });
    shown.onclick = () => {
      window.focus();
      onOpen();
    };
  };
  if (Notification.permission === "granted") show();
  else if (Notification.permission !== "denied") {
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") show();
    });
  }
}

/** The page's half of the notification system: hear, decide, show, and put the remains on
 * screen. */
export function Notifier({
  change,
  page,
  windows,
  onOpen,
}: {
  /** The change and page on screen now, if the page is a change at all. */
  change: string | null;
  page: "dashboard" | "review" | "terminals";
  /** The on-screen change's windows, for telling the window being looked at from the others. */
  windows: TerminalWindow[];
  /** Where a click should take you. */
  onOpen: (change: string, window: string) => void;
}): JSX.Element | null {
  const [toast, setToast] = useState<Notice | null>(null);
  // The listener subscribes once; what it needs to decide changes every render, so it reads the
  // latest from here rather than being rebuilt (and resubscribed) each time.
  const latest = useRef({ change, page, windows, onOpen });
  latest.current = { change, page, windows, onOpen };

  useServerEvent(
    "notify",
    useCallback((data: string) => {
      let notice: Notice;
      try {
        notice = JSON.parse(data) as Notice;
      } catch {
        return; // a notice we cannot read is no notice
      }
      const now = latest.current;
      const viewing =
        now.change === notice.change &&
        now.page === "terminals" &&
        now.windows.some((w) => w.active && w.id === notice.window);
      if (
        !shouldNotify({
          viewing,
          visible: document.visibilityState === "visible",
          focused: pageFocused(),
        })
      ) {
        return;
      }
      deliver(notice, noticeText(notice), () => now.onOpen(notice.change, notice.window));
      setToast(notice);
    }, []),
  );

  if (!toast) return null;
  const text = noticeText(toast);
  return (
    <div
      className="toast"
      role="button"
      tabIndex={0}
      onClick={() => {
        onOpen(toast.change, toast.window);
        setToast(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        onOpen(toast.change, toast.window);
        setToast(null);
      }}
    >
      <button
        className="toast-close"
        title="dismiss"
        onClick={(e) => {
          e.stopPropagation();
          setToast(null);
        }}
      >
        ✕
      </button>
      <span className="toast-title">{text.title}</span>
      <span className="toast-body">{text.body}</span>
      <span className="toast-where">{toast.change}</span>
    </div>
  );
}
