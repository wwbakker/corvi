import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import {
  BrowserClipboardProvider,
  ClipboardAddon,
  type ClipboardSelectionType,
} from "@xterm/addon-clipboard";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { csiuFor, isNewWindowKey, type Platform } from "@corvi/terminals/model";
import type { RemoteAvailabilityReasonDto } from "@corvi/contracts/availability";
import { shouldKeepSocket } from "./socketTarget.ts";

/** How much scrollback the page keeps: as much as the server serializes, so a resume is whole. */
const SCROLLBACK = 5000;

/** Copy the terminal's selection to the system clipboard, or paste the clipboard back. The page
 * owns these chords because a terminal cannot: Ctrl+C is the interrupt, so copying keeps the
 * Shift (Ctrl+Shift+C/V) or uses the platform's command key (Cmd on macOS, Super on Linux), and
 * a browser fires no paste shortcut for Ctrl+Shift+V. Failures — a denied permission, a clipboard
 * that will not answer — are silent: the selection is still on screen. */
const copySelection = async (term: Terminal): Promise<void> => {
  const selection = term.getSelection();
  if (!selection) return;
  await navigator.clipboard.writeText(selection).catch(() => undefined);
};

const pasteClipboard = async (term: Terminal): Promise<void> => {
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) term.paste(text);
};

/** The end (exclusive) of a selection clamped to its last non-empty cell, or undefined when the
 * selection covers only blank cells. xterm's range can run into empty rows when the drag goes past
 * the content; trimming there keeps both the highlight and the copied text honest. */
const clampSelectionEnd = (
  term: Terminal,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } | undefined => {
  const buffer = term.buffer.active;
  for (let y = end.y; y >= start.y; y--) {
    const line = buffer.getLine(y);
    if (line === undefined) continue;
    // `end` is exclusive: on the end row the selection stops before `end.x`; on an inner row it runs
    // to the line's end.
    const lastX = y === end.y ? end.x - 1 : line.length - 1;
    for (let x = lastX; x >= (y === start.y ? start.x : 0); x--) {
      const cell = line.getCell(x);
      if (cell !== undefined && cell.getChars().trim() !== "") return { x: x + 1, y };
    }
  }
  return undefined;
};

/** A colour from the sheet's tokens (apps/web/src/app-root/styles.css): the terminal's surface
 * must read as the app's, and a second copy of the palette here is a copy that drifts. */
const themeColor = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Show the cursor after an empty reset: `term.reset()` does not clear DECTCEM, so a cursor a
 * full-screen program hid would otherwise stick. The server's snapshots carry it themselves. */
const SHOW_CURSOR = "\x1b[?25h";

/** The renderer's cell size and its `clear`, from the same private core the bundled FitAddon
 * reads. There is no public API; the narrow cast follows `screen.ts`'s `activeEncoding` precedent. */
type CellSize = { readonly width: number; readonly height: number };
type RenderService = {
  readonly dimensions: { readonly css: { readonly cell: CellSize } };
  readonly clear: () => void;
};
const renderService = (term: Terminal): RenderService | undefined =>
  (term as unknown as { readonly _core?: { readonly _renderService?: RenderService } })._core?._renderService;

/** Fit the grid to the host's full width. The bundled `FitAddon` subtracts a scrollbar strip
 * (`scrollback === 0 ? 0 : overviewRuler?.width || 14`) from the parent width, but xterm v6's
 * scrollbar is an absolute overlay that takes no layout space, so the strip is a dead gutter (a
 * whole one in a program like pi, which keeps no scrollback). This mirrors the addon's fit — parent
 * width and height minus the terminal's padding, floored by the renderer's cell size — without the
 * subtraction, so the scrollbar overlays the last columns. */
const fitTerminal = (term: Terminal): void => {
  const element = term.element;
  const parent = element?.parentElement;
  if (!element || !parent) return;
  const renderer = renderService(term);
  const cell = renderer?.dimensions.css.cell;
  if (renderer === undefined || cell === undefined || cell.width === 0 || cell.height === 0) return;
  const parentStyle = window.getComputedStyle(parent);
  const parentWidth = Math.max(0, parseInt(parentStyle.getPropertyValue("width"), 10));
  const parentHeight = parseInt(parentStyle.getPropertyValue("height"), 10);
  const style = window.getComputedStyle(element);
  const paddingWidth =
    parseInt(style.getPropertyValue("padding-left"), 10) + parseInt(style.getPropertyValue("padding-right"), 10);
  const paddingHeight =
    parseInt(style.getPropertyValue("padding-top"), 10) + parseInt(style.getPropertyValue("padding-bottom"), 10);
  const cols = Math.max(2, Math.floor((parentWidth - paddingWidth) / cell.width));
  const rows = Math.max(1, Math.floor((parentHeight - paddingHeight) / cell.height));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  if (term.cols === cols && term.rows === rows) return;
  // The addon clears the renderer before resizing to force a full render; keep that parity.
  renderer.clear();
  term.resize(cols, rows);
};

/** The provider the clipboard addon writes through. A program can send its copy as an OSC 52
 * sequence with the selection field empty (`ESC ] 52 ; ; <base64>`), which the protocol reads as
 * the clipboard; the addon passes that through and the base provider would ignore it. A failure —
 * a denied permission, a clipboard that will not answer — is swallowed the way `copySelection`
 * swallows its own: the selection is still on screen, and the addon's promise goes back into
 * xterm's parser, so the input pipeline must not break. */
class QuietClipboardProvider extends BrowserClipboardProvider {
  override writeText(selection: ClipboardSelectionType, text: string): Promise<void> {
    // Only the system clipboard exists here; an empty selection and `c` both mean it. (`p`, the
    // primary selection, has no web API and is left alone.)
    if ((selection as string) !== "" && (selection as string) !== "c") return Promise.resolve();
    return navigator.clipboard.writeText(text).catch(() => undefined);
  }
}

/** The font size is a page preference, kept across reloads; a terminal that remembers the size
 * you set is the least a native-feeling one does. */
const FONT_SIZE_KEY = "corvi.terminal.fontSize";
const FONT_SIZE_DEFAULT = 13;
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const readFontSize = (): number => {
  try {
    const value = Number(localStorage.getItem(FONT_SIZE_KEY));
    return Number.isInteger(value) && value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX ? value : FONT_SIZE_DEFAULT;
  } catch {
    return FONT_SIZE_DEFAULT;
  }
};

/**
 * The change's terminal: a pty owned by the terminal host, rendered by xterm.js in the page
 * itself.
 *
 * Which window you are in, and how to get to another, is the navigation column's job. This is the
 * terminal, the focus, and the new-window chord. The server owns the screen (a headless xterm fed
 * every host byte, `apps/server/src/terminals/server/screen.ts`); this xterm is its renderer — the
 * scrollback, selection, scrollbar, find and links are drawn here, and a connect replays the
 * server's snapshot before the live bytes.
 *
 * The URL is fetched by the app on arrival rather than here, so opening the page does not wait
 * behind the dashboard's CLI calls for one of the browser's six connections.
 */
export function TerminalPane({
  changeId,
  url,
  sessionId,
  error,
  unavailable,
  visible,
  focusRequest,
  platform,
  onNewWindow,
}: {
  changeId: string;
  url: string | null;
  /** Which pane this shows: the socket attaches to that pane's own pty, and the pane reconnects
   * when it changes. Absent means the change's active window's active pane. */
  sessionId?: string | null;
  error: string | null;
  /** The owning workspace is unavailable: no socket is opened, and the pane says why instead of
   * reconnecting. Undefined for the local server, which is always reachable. */
  unavailable?: RemoteAvailabilityReasonDto | null;
  /** Whether this is the page in front: what to focus, when to connect, and when the
   * new-window chord belongs to us. */
  visible: boolean;
  /** A counter the page bumps when something that took the keyboard — the cheat sheet — has closed:
   * nothing in here would put the focus back by itself, and a terminal you have to click before
   * typing is a terminal you have clicked twice. */
  focusRequest?: number;
  /** The server's platform, which decides the chord: cmd-t on macOS, ctrl-alt-t on Linux (the
   * same test the server's own key handling applies, from @corvi/terminals/model). */
  platform: Platform;
  onNewWindow: () => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  /** The change and window the open socket belongs to: a different change or tab needs a
   * different pty. */
  const openedFor = useRef<string | null>(null);
  /** A resize that arrives while the socket is still connecting: sent as soon as it opens. */
  const pendingResize = useRef<{ cols: number; rows: number } | null>(null);
  /** The host session id the **current** socket resolved to, from its own control frame's
   * `sessionId`. A superseded socket's late frame must not claim it, so the message handler
   * ignores frames from a socket that is no longer `socket.current`. */
  const socketSession = useRef<string | null>(null);
  /** Whether the current socket opened without naming a pane, so the server resolved the active
   * one for it. Only then may a later target that names that same pane be treated as a rename
   * rather than a switch: after a real switch, a same-named target is a fresh socket's job. */
  const openedUnnamed = useRef(false);
  /** The same id as state, so the view can say "attached" only while it matches the window the
   * page names: a stale socket's claim drops in the very render the window changes. */
  const [attached, setAttached] = useState<string | null>(null);
  /** How the current socket is doing. The surface it drives is truthful: an open socket without a
   * session is "connecting", a socket that closed without being told the session ended is
   * "reconnecting", and only an `exit` frame is evidence that the session is over. */
  const [socketState, setSocketState] = useState<"idle" | "connecting" | "open" | "closed">("idle");
  /** The session told the page it exited: the pane says so, scoped to this terminal's shell, not
   * to every shell of the change. */
  const [ended, setEnded] = useState(false);
  /** Reconnection: a bounded backoff while the server is down, stopped when the session itself is
   * gone or the pane unmounts. */
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  /** The session told the page it is gone: a close after this is final, not a server restart. */
  const sessionGone = useRef(false);
  /** Another window took this terminal's one live client: the pane stops streaming and offers to
   * take it back, rather than treating the close as the session ending. */
  const detachedRef = useRef(false);
  const [detached, setDetached] = useState(false);
  /** Bumped to trigger a reconnect attempt after the backoff. */
  const [reconnect, setReconnect] = useState(0);
  /** Bumped when the terminal instance is recreated, so the socket effect reconnects after its
   * cleanup closed the old connection (a platform change, if one ever comes). */
  const [generation, setGeneration] = useState(0);
  const [fontSize, setFontSize] = useState<number>(readFontSize);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The link under the pointer: the URL and the point its tooltip is anchored at. */
  const [linkTooltip, setLinkTooltip] = useState<{ url: string; x: number; y: number } | null>(null);
  const linkTooltipRef = useRef<HTMLDivElement>(null);

  // The xterm instance, once: it owns the screen for as long as the pane is mounted. The session
  // behind it is the socket's (below), so hiding the pane keeps the shells running.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
    };
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      // xterm owns the screen now: the scrollback is real, and the scrollbar comes with it.
      scrollback: SCROLLBACK,
      fontSize: readFontSize(),
      // A cursor you can find: xterm draws an outline when the terminal is not focused and takes
      // the cursor colour from the foreground, which disappears over a like-coloured cell. A
      // filled block in both states, in the sheet's text colour with the well under it, is visible
      // wherever it sits.
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "block",
      // The terminal is the deepest surface the app has, and the sheet owns it: xterm takes the
      // background from the same `--well` token (apps/web/src/app-root/styles.css) rather than a
      // second copy of the colour here, which is the kind of pair that drifts.
      theme: {
        background: themeColor("--well"),
        foreground: "#e6edf3",
        cursor: themeColor("--text"),
        cursorAccent: themeColor("--well"),
      },
      // Option-drag forces xterm's own selection where a full-screen program has enabled mouse
      // reporting and would otherwise swallow the drag; a program inside the shell can turn
      // reporting on itself.
      macOptionClickForcesSelection: platform === "mac",
    });
    // A program (or a login script) can send its copy as OSC 52; xterm ignores it without this
    // addon, which writes the system clipboard.
    term.loadAddon(new ClipboardAddon(undefined, new QuietClipboardProvider()));
    const search = new SearchAddon();
    term.loadAddon(search);
    // Cmd/Ctrl+click opens a detected URL; a plain click is left for selection. A hover shows a
    // tooltip — the URL and the chord — so the link's click affordance is discoverable.
    term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (event.ctrlKey || event.metaKey) window.open(uri, "_blank", "noopener");
        },
        {
          hover: (event, text) => setLinkTooltip({ url: text, x: event.clientX, y: event.clientY }),
          leave: () => setLinkTooltip(null),
        },
      ),
    );
    term.open(element);
    try {
      // Chromium composites hardware-accelerated (the reason for the Electron host); where it
      // cannot, xterm's own renderer takes over rather than leaving a dead canvas.
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // no WebGL: the default renderer is correct, only busier
    }
    // Input goes out through whatever socket is open, so a reconnected pane keeps typing.
    const input = term.onData((chunk) => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(chunk));
    });
    // Mouse input in the legacy DEFAULT (X10) encoding arrives as `onBinary`, a string of one byte
    // per char rather than UTF-8 text, and would otherwise be dropped: send the raw bytes.
    const binary = term.onBinary((chunk) => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(chunk, (c) => c.charCodeAt(0)));
    });
    // A selection dragged into empty rows ends at the last non-empty cell: xterm's range can run
    // into blanks, so clamp it on every change (both the highlight and `getSelection()` come from
    // the range). Mid-drag each move clamps its own trailing blanks and dragging back still works;
    // `clamping` stops the re-entrant change our own `select` fires.
    let clamping = false;
    const selection = term.onSelectionChange(() => {
      if (clamping) return;
      const position = term.getSelectionPosition();
      if (position === undefined) return;
      const end = clampSelectionEnd(term, position.start, position.end);
      if (end === undefined || (end.x === position.end.x && end.y === position.end.y)) return;
      const length = (end.y - position.start.y) * term.cols + (end.x - position.start.x);
      if (length <= 0) return;
      clamping = true;
      try {
        term.select(position.start.x, position.start.y, length);
      } finally {
        clamping = false;
      }
    });
    // A scroll moves the link out from under the pointer: the tooltip must not stay at a stale
    // point over a line that has scrolled away.
    const scroll = term.onScroll(() => setLinkTooltip(null));
    terminal.current = term;
    searchAddon.current = search;
    // The page tests read the buffer through the host element: xterm's WebGL canvas has no DOM
    // text to read, and the buffer is what the page's tests read.
    (element as HTMLElement & { corviTerminal?: Terminal }).corviTerminal = term;
    setGeneration((n) => n + 1);
    return () => {
      input.dispose();
      binary.dispose();
      selection.dispose();
      scroll.dispose();
      setLinkTooltip(null);
      socket.current?.close();
      socket.current = null;
      openedFor.current = null;
      pendingResize.current = null;
      delete (element as HTMLElement & { corviTerminal?: Terminal }).corviTerminal;
      socketSession.current = null;
      openedUnnamed.current = false;
      term.dispose();
      terminal.current = null;
      searchAddon.current = null;
    };
  }, [platform]);

  /** Tell the pty its grid changed after a fit. A connecting socket remembers the size and sends
   * it on open, before the shell can be typed into. */
  const sendSize = useCallback((term: Terminal): void => {
    const ws = socket.current;
    if (!ws) return;
    const size = { cols: term.cols, rows: term.rows };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", ...size }));
    else if (ws.readyState === WebSocket.CONNECTING) pendingResize.current = size;
  }, []);

  /** Take the terminal back from the window that took it: forget the detach, close whatever socket
   * is left, and reconnect — the fresh attach supersedes the other window in turn. */
  const takeOver = useCallback((): void => {
    const ws = socket.current;
    socket.current = null;
    ws?.close();
    detachedRef.current = false;
    setDetached(false);
    reconnectAttempt.current = 0;
    setReconnect((n) => n + 1);
  }, []);

  // The font size can change without rebuilding the terminal, which would lose the screen.
  useEffect(() => {
    const term = terminal.current;
    if (term) {
      const before = { cols: term.cols, rows: term.rows };
      term.options.fontSize = fontSize;
      fitTerminal(term);
      // The font change resizes the grid but not the host, so the ResizeObserver never fires: tell
      // the pty directly or the shell keeps wrapping at the old width.
      if (term.cols !== before.cols || term.rows !== before.rows) sendSize(term);
    }
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
    } catch {
      // private mode: the size is just not remembered
    }
  }, [fontSize, sendSize]);

  // One socket, when the terminal is first shown and the URL is known. The fit happens before
  // the connect: the first size the shell sees is the right one, so switching to the terminal
  // is not a resize every full-screen program has to redraw for.
  useLayoutEffect(() => {
    // The URL names the change, the id names the pane: a different change or a different tab
    // needs a different pty. The server keeps the screen of the one being left.
    const target = `${url ?? ""}#${sessionId ?? ""}`;
    // A detach belongs to the pane the other window took; naming a different pane is a fresh
    // start, not the window that took this one.
    if (detachedRef.current && openedFor.current !== target) {
      detachedRef.current = false;
      setDetached(false);
    }
    // No target, or the workspace is unavailable: close whatever socket is open *before* the
    // rename-keep logic below. The first-connect rename case always has a non-null URL, so this
    // cannot steal it; and a pane that says "not connected" must not still be streaming input.
    // Hiding the pane is deliberately *not* here: a hidden terminal keeps its attachment (and its
    // scrollback); only a missing/blocked/retargeted target closes.
    if (!url || unavailable) {
      const open = socket.current;
      if (open) {
        socket.current = null;
        socketSession.current = null;
        openedFor.current = null;
        setAttached(null);
        setSocketState("closed");
        open.close();
      }
      return;
    }
    if (socket.current && openedFor.current !== target) {
      // Only the unnamed first connect may be renamed: the server resolved the active pane for it,
      // and the window list then names that same pane, so a reconnect would drop keystrokes in the
      // gap. Any other change is a switch to a different pane, and only a fresh socket can be
      // trusted to have resolved it — a stale socket's `sessionId` (rapid A → B → A) is not
      // evidence that this socket serves A.
      const kept = shouldKeepSocket({
        unnamed: openedUnnamed.current,
        resolved: socketSession.current,
        sessionId,
      });
      if (kept) {
        openedFor.current = target;
      } else {
        socket.current.close();
        socket.current = null;
      }
    }
    // Hidden: keep the existing attachment (and its screen); do not open a new one. The next shown
    // render opens it.
    if (!visible) return;
    // The other window holds the one live client: stay off the socket until the page takes it back.
    if (detachedRef.current) return;
    const term = terminal.current;
    if (!term || !host.current) return;
    if (socket.current) return;
    fitTerminal(term);
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const windowQuery = sessionId === undefined || sessionId === null ? "" : `&session=${encodeURIComponent(sessionId)}`;
    setSocketState("connecting");
    setEnded(false);
    const ws = new WebSocket(`${scheme}//${location.host}${url}?cols=${term.cols}&rows=${term.rows}${windowQuery}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event: MessageEvent) => {
      if (socket.current !== ws) return; // a superseded socket: its screen is not this pane's
      if (typeof event.data === "string") {
        let value: { type?: unknown; data?: unknown; sessionId?: unknown };
        try {
          value = JSON.parse(event.data) as typeof value;
        } catch {
          return;
        }
        if (typeof value.sessionId === "string") {
          socketSession.current = value.sessionId;
          setAttached(value.sessionId);
        }
        if (value.type === "reset") {
          // No screen yet: a fresh terminal, then the live bytes.
          term.reset();
          term.write(SHOW_CURSOR);
        } else if (value.type === "snapshot" && typeof value.data === "string") {
          // The server's screen, replayed into a fresh terminal, then the live bytes after it.
          term.reset();
          term.write(value.data);
        } else if (value.type === "detached") {
          // Another window took the one live client: the close that follows is deliberate, not the
          // session ending, so show the take-over affordance and do not reconnect.
          detachedRef.current = true;
          setDetached(true);
          setAttached(null);
        } else if (value.type === "exit") {
          // The session is gone: the close that follows is final, not a restart to retry. This is
          // the only evidence that ends a pane; a closed socket alone is a reconnect.
          sessionGone.current = true;
          setEnded(true);
        }
        return;
      }
      // Raw output, binary: the live bytes the snapshot resumed from.
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(event.data as ArrayBufferLike);
      term.write(bytes);
    };
    // A resize that happened while this socket was connecting was queued; the shell starts at
    // the size it now has.
    ws.onopen = () => {
      if (socket.current !== ws) return; // a superseded socket
      // A live connection resets the backoff and clears any earlier "gone" or "detached" answer.
      reconnectAttempt.current = 0;
      sessionGone.current = false;
      detachedRef.current = false;
      setDetached(false);
      setSocketState("open");
      if (!pendingResize.current) return;
      ws.send(JSON.stringify({ type: "resize", ...pendingResize.current }));
      pendingResize.current = null;
    };
    // A socket that closes (its session died, the server restarted) is forgotten. The next
    // connection starts with the server's snapshot; a server restart is retried with a bounded
    // backoff, a session that says it is gone is not.
    ws.onclose = () => {
      if (socket.current !== ws) return; // a superseded socket (another change's URL)
      socket.current = null;
      socketSession.current = null;
      setAttached(null);
      setSocketState("closed");
      pendingResize.current = null;
      // A detached close is deliberate: the other window has it, and this pane waits for the
      // take-over rather than racing it for the connection.
      if (detachedRef.current || sessionGone.current || !mounted.current) return;
      reconnectAttempt.current = Math.min(reconnectAttempt.current + 1, 6);
      const delay = Math.min(500 * 2 ** (reconnectAttempt.current - 1), 5000);
      reconnectTimer.current = setTimeout(() => {
        if (mounted.current) setReconnect((n) => n + 1);
      }, delay);
    };
    socket.current = ws;
    openedFor.current = target;
    socketSession.current = null;
    openedUnnamed.current = sessionId === undefined || sessionId === null;
    // Deliberately no cleanup: hiding the pane (the dashboard, another change's page) must keep
    // the host client attached, which is what leaves the shells running.
  }, [url, sessionId, visible, unavailable, generation, reconnect]);

  // A shown or resized pane re-fits, and tells the pty. Before paint, so the grid and the shell
  // agree by the time the frame is visible.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const term = terminal.current;
      if (!term) return;
      if (element.clientWidth === 0 || element.clientHeight === 0) return; // hidden: nothing to fit
      const before = { cols: term.cols, rows: term.rows };
      fitTerminal(term);
      if (term.cols === before.cols && term.rows === before.rows) return;
      sendSize(term);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sendSize]);

  // Middle-click pastes the system clipboard, the way a Linux terminal does.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 1) return;
      e.preventDefault(); // no autoscroll, and no native paste
      e.stopPropagation();
      const term = terminal.current;
      if (!term) return;
      term.focus();
      void pasteClipboard(term);
    };
    element.addEventListener("mousedown", onDown, true);
    return () => element.removeEventListener("mousedown", onDown, true);
  }, []);

  // The keys xterm cannot encode are sent by the page itself, and the clipboard, find and
  // font-size chords are the page's too. Capture phase, ahead of xterm's own textarea handler,
  // which would send a plain carriage return for the one and a control byte for the other.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onKey = (e: KeyboardEvent): void => {
      const term = terminal.current;
      if (!term) return;
      // Copy and paste are the page's: Ctrl+Shift+C/V everywhere, the platform's command key
      // (Cmd on macOS, Super on Linux), and the Linux terminal convention Ctrl+Insert / 
      // Shift+Insert — which is what a compositor's "universal clipboard" sends a window it treats
      // as a terminal. Swallowed even when there is nothing to copy or paste, so a shifted chord
      // never turns into the control byte it would be without it, and the shell keeps plain Ctrl+C
      // as the interrupt.
      const commandChord =
        !e.altKey && ((e.ctrlKey && e.shiftKey && !e.metaKey) || (e.metaKey && !e.ctrlKey && !e.shiftKey));
      const copy = (commandChord && e.code === "KeyC") || (e.code === "Insert" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey);
      const paste = (commandChord && e.code === "KeyV") || (e.code === "Insert" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey);
      if (copy || paste) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (copy) void copySelection(term);
        else void pasteClipboard(term);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setFindOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.code === "Minus" || e.code === "Equal" || e.code === "Digit0")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.code === "Digit0") setFontSize(FONT_SIZE_DEFAULT);
        else if (e.code === "Minus") setFontSize((n) => Math.max(FONT_SIZE_MIN, n - 1));
        else setFontSize((n) => Math.min(FONT_SIZE_MAX, n + 1));
        return;
      }
      const sequence = csiuFor(e);
      if (!sequence) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      term.input(sequence);
    };
    element.addEventListener("keydown", onKey, true);
    return () => element.removeEventListener("keydown", onKey, true);
  }, []);

  // The new-window chord, from the page and from inside the terminal, which is where the
  // keyboard usually is.
  useEffect(() => {
    if (!visible) return;
    const key = (e: KeyboardEvent): void => {
      if (!isNewWindowKey(e, platform)) return;
      e.preventDefault();
      onNewWindow();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [visible, onNewWindow, platform]);

  // Opening it should be enough to start typing — and so should closing anything that took the
  // keyboard away, which is what `focusRequest` counts.
  useEffect(() => {
    if (visible && !findOpen) terminal.current?.focus();
  }, [visible, url, focusRequest, findOpen]);

  // A tooltip belongs to the link under the pointer in one pane: a window switch, a reconnect or
  // a hidden-then-shown pane must not leave it over the new screen.
  useEffect(() => {
    setLinkTooltip(null);
  }, [url, sessionId, visible]);

  // Keep the tooltip inside the viewport. It anchors where the link was entered — xterm fires
  // `hover` once per link, not per mousemove — so the point is fixed while the link is hovered.
  // Before paint, so it never flashes off-screen.
  useLayoutEffect(() => {
    const element = linkTooltipRef.current;
    if (!element || !linkTooltip) return;
    // Measure the box at its real (post-move) size, not at wherever React last painted it: a
    // shrink-to-fit box measured at the old point can flip the wrong way near an edge.
    element.style.left = "0";
    element.style.top = "0";
    const margin = 8;
    const gap = 14;
    const rect = element.getBoundingClientRect();
    let left = linkTooltip.x + gap;
    let top = linkTooltip.y + gap;
    if (left + rect.width > window.innerWidth - margin) left = linkTooltip.x - gap - rect.width;
    if (left < margin) left = margin;
    if (top + rect.height > window.innerHeight - margin) top = linkTooltip.y - gap - rect.height;
    if (top < margin) top = margin;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [linkTooltip]);

  // The page's own menu: a right click belongs to the page, not the browser (a terminal has
  // nothing to Inspect), and it holds what a terminal's menu holds.
  const onContextMenu = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault();
    // The menu is the surface now: a tooltip under it would read as menu chrome.
    setLinkTooltip(null);
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Anywhere else dismisses the menu. The menu stops propagation on its own pointerdown, so a
  // click on an item runs before this sees it.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const closeMenu = useCallback((): void => {
    setMenu(null);
    terminal.current?.focus();
  }, []);

  const runFromMenu = useCallback((action: () => void): void => {
    setMenu(null);
    action();
    terminal.current?.focus();
  }, []);

  const closeFind = useCallback((): void => {
    setFindOpen(false);
    setFindText("");
    searchAddon.current?.clearDecorations();
    terminal.current?.focus();
  }, []);

  const selection = terminal.current?.getSelection().trim() ?? "";
  const selectionIsUrl = /^https?:\/\/\S+$/i.test(selection);

  return (
    <div className="terminal">
      {ended && (
        <div className="terminal-gone">
          The shell in this terminal has ended. Other terminals in this change are unaffected.
        </div>
      )}
      {detached && (
        <div className="terminal-detached">
          <p>This terminal is open in another window. Taking it over will detach that window.</p>
          <button onClick={takeOver}>Take over</button>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {unavailable && (
        <div className="terminal-gone" role="status">
          This workspace is unavailable: {unavailable.message} The terminal is not connected; cached
          windows stay listed until it recovers.
        </div>
      )}
      {!url && !error && !unavailable && <p className="hint">starting terminal…</p>}
      {url && !error && !ended && !detached && attached === null && socketState !== "closed" && (
        <p className="hint">connecting…</p>
      )}
      {url && !error && !ended && !detached && socketState === "closed" && (
        <p className="hint">reconnecting…</p>
      )}
      {findOpen && (
        <div className="terminal-find">
          <input
            autoFocus
            value={findText}
            placeholder="Find"
            aria-label="Find in terminal"
            onChange={(e) => {
              setFindText(e.target.value);
              searchAddon.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) searchAddon.current?.findPrevious(findText);
                else searchAddon.current?.findNext(findText);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
          />
        </div>
      )}
      {/* No tooltip: the window's own row already says which change's terminal this is, and a
          floating "terminal for …" over the grid is in the way of reading it. */}
      <div
        ref={host}
        className="terminal-screen"
        hidden={!url}
        // The pane this xterm is rendering, by identity: a test can assert the intended target
        // without reading a positional index out of another list.
        data-session={sessionId ?? ""}
        // The pane is attached only while the open socket is for the window the page currently
        // names (or the page names none and the server resolved one): the tests' readiness gate
        // must not pass on the socket a window switch is about to replace.
        data-attached={attached !== null && (sessionId === undefined || sessionId === null || attached === sessionId) ? "1" : undefined}
        onContextMenu={onContextMenu}
      />
      {linkTooltip && (
        <div
          ref={linkTooltipRef}
          className="terminal-link-tooltip"
          role="tooltip"
          style={{ left: linkTooltip.x, top: linkTooltip.y }}
        >
          <span className="terminal-link-tooltip-url">{linkTooltip.url}</span>
          <span className="terminal-link-tooltip-hint">
            {platform === "mac" ? "Cmd-click to open" : "Ctrl-click to open"}
          </span>
        </div>
      )}
      {menu && (
        <div
          className="terminal-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button role="menuitem" onClick={() => runFromMenu(() => void copySelection(terminal.current!))}>
            Copy
          </button>
          <button role="menuitem" onClick={() => runFromMenu(() => void pasteClipboard(terminal.current!))}>
            Paste
          </button>
          <button role="menuitem" onClick={() => runFromMenu(() => terminal.current?.selectAll())}>
            Select all
          </button>
          <button role="menuitem" onClick={() => runFromMenu(() => terminal.current?.clear())}>
            Clear
          </button>
          <button
            role="menuitem"
            onClick={() =>
              runFromMenu(() => {
                setFindOpen(true);
                setFindText("");
              })
            }
          >
            Find
          </button>
          <button
            role="menuitem"
            disabled={!selectionIsUrl}
            onClick={() => runFromMenu(() => void window.open(selection, "_blank", "noopener"))}
          >
            Open link
          </button>
        </div>
      )}
    </div>
  );
}
