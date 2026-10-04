import { type JSX, useCallback, useRef, useState } from "react";
import { useServerEvent } from "./events.ts";
import { hostOf } from "./host.ts";
import { changeKey } from "./sources.ts";
import type { TerminalWindow } from "../domain/terminal.ts";
import type { Page } from "./Sidebar.tsx";

/**
 * What a window wanting you turns into: a native notification in the app's window, the browser's
 * own where there is no host, and a toast in the page either way.
 *
 * The server does the detecting — it already reads the agent status every tick — and says what
 * happened on the `notify` event. The page does the deciding, because only the page knows what is
 * on screen; the host does the showing (the app's Electron window, apps/web/src/domain/host.ts), because
 * only it can raise the window and play the sound the notification setting asks for.
 *
 * A remote workspace's notification arrives the other way around: the local server's fan-in
 * re-emits the remote's `notify` on the local stream under the `source` envelope, so this hears
 * both and tells them apart by the source it carries (`noticeOf`).
 */
import type { HostNotice } from "../domain/host.ts";

/** The server's `notify` payload: one window that has started wanting the user. */
export type Notice = {
  /** The change the window belongs to. */
  change: string;
  /** The window's backing session id — stable across reordering, unlike the index. */
  window: string;
  /** What the window is called: the session's name when it has one. */
  label: string;
  /** The presenter's own words, e.g. the first sentence of the agent's last answer. */
  note?: string;
  /** Whether the host should play a sound; the settings file decides. */
  sound: boolean;
  /** Which source the change belongs to: the local workspace id for a remote one, absent on a
   * local `notify`. The page sets it from the `source` envelope for a remote one. */
  source?: string;
};

/** The suppression rule, pure so it can be pinned: notify unless you are actually looking at the
 * window that wants you — its change, its terminals page, that window, and a document that is
 * visible and focused. Backgrounded, minimized, another change or another page: notify. */
export const shouldNotify = (looking: {
  viewing: boolean;
  visible: boolean;
  focused: boolean;
}): boolean => !(looking.viewing && looking.visible && looking.focused);

/** Whether the page is showing exactly the window that wants you. Both halves of a change's
 * identity are compared: a local change and a remote one sharing an id are different changes, so
 * neither is mistaken for the one you are looking at (which would wrongly silence its notice). */
export const isViewing = (
  onScreen: { source: string; change: string | null; page: Page; windows: TerminalWindow[] },
  notice: Notice,
): boolean =>
  onScreen.change === notice.change &&
  onScreen.source === (notice.source ?? "") &&
  onScreen.page === "terminals" &&
  onScreen.windows.some((window) => window.active && window.id === notice.window);

/** The notification's words: the session's name, and what it said (or that it is waiting). */
export const noticeText = (notice: Notice): { title: string; body: string } => ({
  title: notice.label,
  body: notice.note?.trim() || "waiting for you",
});

/** The event that carries a notice, read into the notice and its source. A local `notify` is the
 * payload itself, with no source; a remote one rides the fan-in's `source` envelope, whose inner
 * `event` must be `notify` and whose `data` is the same payload. Undefined for anything else — an
 * unreadable notice is no notice, and a `source` envelope for another event is not this one. */
export const noticeOf = (
  event: "notify" | "source",
  data: string,
): { notice: Notice; source: string } | undefined => {
  try {
    if (event === "notify") return { notice: JSON.parse(data) as Notice, source: "" };
    const envelope = JSON.parse(data) as { source?: unknown; event?: unknown; data?: unknown };
    if (envelope.event !== "notify" || typeof envelope.source !== "string") return undefined;
    const notice = JSON.parse(typeof envelope.data === "string" ? envelope.data : "") as Notice;
    return { notice, source: envelope.source };
  } catch {
    return undefined;
  }
};

/** Whether this page has the keyboard. The terminal focuses its own iframe, and focusing a
 * frame still means the page around it is the one you are looking at. */
const pageFocused = (): boolean =>
  document.hasFocus() || document.activeElement?.tagName === "IFRAME";

/** The notification key: stable per (source, change, window), so two servers that mint the same
 * change id and window id do not replace each other's banner. The separator is the one
 * `changeKey` uses — a newline, which no id can contain — because hyphens are legal in workspace
 * and change ids and would let ("a", "b-c") and ("a-b", "c") collide. */
const noticeKey = (notice: Notice): string =>
  `${changeKey(notice.source ?? "", notice.change)}\n${notice.window}`;

/** The payload the host shows, and the click-back it carries. Pure, so the source a remote notice
 * carries — and the key that keeps two sources' banners apart — is pinned. */
export const hostNotice = (
  notice: Notice,
  text: { title: string; body: string },
): HostNotice => ({
  kind: "notify",
  id: noticeKey(notice),
  title: text.title,
  // The change, named by its server when it is not this one's: two servers can mint the same id,
  // so the banner has to say which one — the same `source · change` the toast shows.
  subtitle: notice.source ? `${notice.source} · ${notice.change}` : notice.change,
  body: text.body,
  sound: notice.sound,
  change: notice.change,
  window: notice.window,
  source: notice.source ?? "",
});

/** Show it where it can be shown. The host bridge is the app window (Electron, the same
 * `window.corviHost` shape on both platforms); the browser's Notification is for a page in a real
 * browser; and no path is an error, because the toast is always there. */
function deliver(notice: Notice, text: { title: string; body: string }, onOpen: () => void): void {
  const host = hostOf();
  if (host) {
    host.notify(hostNotice(notice, text));
    return;
  }
  if (typeof Notification === "undefined") return;
  const show = (): void => {
    const shown = new Notification(text.title, {
      body: text.body,
      tag: noticeKey(notice),
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
  source,
  page,
  windows,
  onOpen,
}: {
  /** The change and page on screen now, if the page is a change at all. */
  change: string | null;
  /** The source the on-screen change belongs to: `""` for the local server. */
  source: string;
  page: Page;
  /** The on-screen change's windows, for telling the window being looked at from the others. */
  windows: TerminalWindow[];
  /** Where a click should take you: the change's source, the change, and the window. */
  onOpen: (source: string, change: string, window: string) => void;
}): JSX.Element | null {
  const [toast, setToast] = useState<Notice | null>(null);
  // The listener subscribes once; what it needs to decide changes every render, so it reads the
  // latest from here rather than being rebuilt (and resubscribed) each time.
  const latest = useRef({ change, source, page, windows, onOpen });
  latest.current = { change, source, page, windows, onOpen };

  // One handler for both spellings — a local `notify`, and a remote `notify` carried in the
  // fan-in's `source` envelope. The source is the only difference; the decision and the showing
  // are the same.
  const hear = useCallback((event: "notify" | "source", data: string): void => {
    const parsed = noticeOf(event, data);
    if (!parsed) return;
    const notice: Notice = { ...parsed.notice, source: parsed.source };
    const now = latest.current;
    if (
      !shouldNotify({
        viewing: isViewing(now, notice),
        visible: document.visibilityState === "visible",
        focused: pageFocused(),
      })
    ) {
      return;
    }
    deliver(notice, noticeText(notice), () =>
      now.onOpen(parsed.source, notice.change, notice.window),
    );
    setToast(notice);
  }, []);

  useServerEvent(
    "notify",
    useCallback((data: string) => hear("notify", data), [hear]),
  );
  useServerEvent(
    "source",
    useCallback((data: string) => hear("source", data), [hear]),
  );

  if (!toast) return null;
  const text = noticeText(toast);
  // Which change the notice is about, named by its source when it is not this server's.
  const where = toast.source ? `${toast.source} · ${toast.change}` : toast.change;
  return (
    <div
      className="toast"
      role="button"
      tabIndex={0}
      // Keeps the focus where it was: the toast floats over a terminal, and taking the keyboard
      // away to dismiss it would leave a terminal you have to click before typing again. The
      // same reason as the actions menu's button (apps/web/src/app-root/ActionsMenu.tsx).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onOpen(toast.source ?? "", toast.change, toast.window);
        setToast(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        onOpen(toast.source ?? "", toast.change, toast.window);
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
      <span className="toast-where">{where}</span>
    </div>
  );
}
