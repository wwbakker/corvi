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
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { csiuFor, isNewWindowKey, type Platform } from "@corvi/terminals/model";

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

/** A colour from the sheet's tokens (apps/web/src/app-root/styles.css): the terminal's surface
 * must read as the app's, and a second copy of the palette here is a copy that drifts. */
const themeColor = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Show the cursor after an empty reset: `term.reset()` does not clear DECTCEM, so a cursor a
 * full-screen program hid would otherwise stick. The server's snapshots carry it themselves. */
const SHOW_CURSOR = "\x1b[?25h";

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
  windowId,
  error,
  visible,
  focusRequest,
  platform,
  onNewWindow,
  windows,
}: {
  changeId: string;
  url: string | null;
  /** Which of the change's windows this pane shows: the socket attaches to that window's own pty,
   * and the pane reconnects when it changes. Absent means the change's active window. */
  windowId?: string | null;
  error: string | null;
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
  /** How many windows this change's session has: none while one is starting, and none forever
   * once it is gone. */
  windows: number;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  /** The change and window the open socket belongs to: a different change or tab needs a
   * different pty. */
  const openedFor = useRef<string | null>(null);
  /** A resize that arrives while the socket is still connecting: sent as soon as it opens. */
  const pendingResize = useRef<{ cols: number; rows: number } | null>(null);
  /** The host session id the open socket resolved to, from the control frame's `sessionId`. */
  const attachedSession = useRef<string | null>(null);
  /** The same id as state, so the view can say "attached" only while it matches the window the
   * page names: a stale socket's claim drops in the very render the window changes. */
  const [attached, setAttached] = useState<string | null>(null);
  /** Reconnection: a bounded backoff while the server is down, stopped when the session itself is
   * gone or the pane unmounts. */
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  /** The session told the page it is gone: a close after this is final, not a server restart. */
  const sessionGone = useRef(false);
  /** Bumped to trigger a reconnect attempt after the backoff. */
  const [reconnect, setReconnect] = useState(0);
  /** Bumped when the terminal instance is recreated, so the socket effect reconnects after its
   * cleanup closed the old connection (a platform change, if one ever comes). */
  const [generation, setGeneration] = useState(0);
  const [fontSize, setFontSize] = useState<number>(readFontSize);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // A terminal that was fine when the tab opened can lose its session while you watch it, the way
  // a killed server does. The window list going empty and staying empty is what that looks like
  // from here; waiting a moment tells "starting" from "lost".
  const [lostWhileOpen, setLostWhileOpen] = useState(false);
  useEffect(() => {
    if (!visible || windows > 0) {
      setLostWhileOpen(false);
      return;
    }
    const timer = setTimeout(() => setLostWhileOpen(true), 5000);
    return () => clearTimeout(timer);
  }, [visible, windows]);

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
    const fit = new FitAddon();
    term.loadAddon(fit);
    // A program (or a login script) can send its copy as OSC 52; xterm ignores it without this
    // addon, which writes the system clipboard.
    term.loadAddon(new ClipboardAddon(undefined, new QuietClipboardProvider()));
    const search = new SearchAddon();
    term.loadAddon(search);
    // Cmd/Ctrl+click opens a detected URL; a plain click is left for selection.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) window.open(uri, "_blank", "noopener");
      }),
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
    terminal.current = term;
    fitAddon.current = fit;
    searchAddon.current = search;
    // The page tests read the buffer through the host element: xterm's WebGL canvas has no DOM
    // text to read, and the buffer is what the page's tests read.
    (element as HTMLElement & { corviTerminal?: Terminal }).corviTerminal = term;
    setGeneration((n) => n + 1);
    return () => {
      input.dispose();
      socket.current?.close();
      socket.current = null;
      openedFor.current = null;
      pendingResize.current = null;
      delete (element as HTMLElement & { corviTerminal?: Terminal }).corviTerminal;
      attachedSession.current = null;
      term.dispose();
      terminal.current = null;
      fitAddon.current = null;
      searchAddon.current = null;
    };
  }, [platform]);

  // The font size can change without rebuilding the terminal, which would lose the screen.
  useEffect(() => {
    const term = terminal.current;
    if (term) {
      term.options.fontSize = fontSize;
      fitAddon.current?.fit();
    }
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
    } catch {
      // private mode: the size is just not remembered
    }
  }, [fontSize]);

  // One socket, when the terminal is first shown and the URL is known. The fit happens before
  // the connect: the first size the shell sees is the right one, so switching to the terminal
  // is not a resize every full-screen program has to redraw for.
  useLayoutEffect(() => {
    // The URL names the change, the id names the window: a different change or a different tab
    // needs a different pty. The server keeps the screen of the one being left.
    const target = `${url ?? ""}#${windowId ?? ""}`;
    if (socket.current && openedFor.current !== target) {
      // The first connect happens before the window list arrives, and the server resolves the
      // active window for it. When the caller then names that same window, the socket is already
      // attached: renaming the target is not a replay, and reconnecting would drop keystrokes in
      // the gap between the two sockets.
      if (windowId != null && attachedSession.current === windowId) {
        openedFor.current = target;
      } else {
        socket.current.close();
        socket.current = null;
      }
    }
    if (!url || !visible) return;
    const term = terminal.current;
    const fit = fitAddon.current;
    if (!term || !fit || !host.current) return;
    if (socket.current) return;
    fit.fit();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const windowQuery = windowId === undefined || windowId === null ? "" : `&window=${encodeURIComponent(windowId)}`;
    const ws = new WebSocket(`${scheme}//${location.host}${url}?cols=${term.cols}&rows=${term.rows}${windowQuery}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        let value: { type?: unknown; data?: unknown; sessionId?: unknown };
        try {
          value = JSON.parse(event.data) as typeof value;
        } catch {
          return;
        }
        if (typeof value.sessionId === "string") {
          attachedSession.current = value.sessionId;
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
        } else if (value.type === "exit") {
          // The session is gone: the close that follows is final, not a restart to retry.
          sessionGone.current = true;
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
      // A live connection resets the backoff and clears any earlier "gone" answer.
      reconnectAttempt.current = 0;
      sessionGone.current = false;
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
      attachedSession.current = null;
      setAttached(null);
      pendingResize.current = null;
      if (sessionGone.current || !mounted.current) return;
      reconnectAttempt.current = Math.min(reconnectAttempt.current + 1, 6);
      const delay = Math.min(500 * 2 ** (reconnectAttempt.current - 1), 5000);
      reconnectTimer.current = setTimeout(() => {
        if (mounted.current) setReconnect((n) => n + 1);
      }, delay);
    };
    socket.current = ws;
    openedFor.current = target;
    // Deliberately no cleanup: hiding the pane (the dashboard, another change's page) must keep
    // the host client attached, which is what leaves the shells running.
  }, [url, windowId, visible, generation, reconnect]);

  // A shown or resized pane re-fits, and tells the pty. Before paint, so the grid and the shell
  // agree by the time the frame is visible.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const term = terminal.current;
      const fit = fitAddon.current;
      if (!term || !fit) return;
      if (element.clientWidth === 0 || element.clientHeight === 0) return; // hidden: nothing to fit
      const before = { cols: term.cols, rows: term.rows };
      fit.fit();
      if (term.cols === before.cols && term.rows === before.rows) return;
      const ws = socket.current;
      if (!ws) return;
      const size = { cols: term.cols, rows: term.rows };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", ...size }));
      // Still connecting: remember it, and onopen sends it before the shell can be typed into.
      else if (ws.readyState === WebSocket.CONNECTING) pendingResize.current = size;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  // The page's own menu: a right click belongs to the page, not the browser (a terminal has
  // nothing to Inspect), and it holds what a terminal's menu holds.
  const onContextMenu = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault();
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
      {lostWhileOpen && (
        <div className="terminal-gone">
          The terminal session for this change is gone: the shells in it, and anything that was
          running in them, are lost. Reload this page to start a fresh session.
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {!url && !error && <p className="hint">starting terminal…</p>}
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
        // The pane is attached only while the open socket is for the window the page currently
        // names (or the page names none and the server resolved one): the tests' readiness gate
        // must not pass on the socket a window switch is about to replace.
        data-attached={attached !== null && (windowId === undefined || windowId === null || attached === windowId) ? "1" : undefined}
        onContextMenu={onContextMenu}
      />
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
