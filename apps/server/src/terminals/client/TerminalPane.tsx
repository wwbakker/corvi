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
import { WebglAddon } from "@xterm/addon-webgl";
import { csiuFor, isNewWindowKey, type Platform } from "@corvi/terminals/model";

/** Copy the terminal's selection to the system clipboard, or paste the clipboard back. The page
 * owns these chords because a terminal cannot: Ctrl+C is the interrupt, so copying keeps the
 * Shift the way every Linux terminal does, and a browser fires no paste shortcut for
 * Ctrl+Shift+V. Failures — a denied permission, a clipboard that will not answer — are silent:
 * the selection is still on screen. */
const copySelection = async (term: Terminal): Promise<void> => {
  const selection = term.getSelection();
  if (!selection) return;
  await navigator.clipboard.writeText(selection).catch(() => undefined);
};

const pasteClipboard = async (term: Terminal): Promise<void> => {
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) term.paste(text);
};

/** The surface the sheet and xterm have to agree on: the terminal's background is `--well`
 * (apps/server/src/app-root/styles.css), and a second copy of the colour here is a copy that drifts. */
const wellTone = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--well").trim();

/** The provider the clipboard addon writes through. tmux sends its copies with the selection
 * field empty (`ESC ] 52 ; ; <base64>`), which the protocol reads as the clipboard; the addon
 * passes that through and the base provider would ignore it. A failure — a denied permission, a
 * clipboard that will not answer — is swallowed the way `copySelection` swallows its own: the
 * selection is still on screen, and the addon's promise goes back into xterm's parser, so the
 * input pipeline must not break. */
class QuietClipboardProvider extends BrowserClipboardProvider {
  override writeText(selection: ClipboardSelectionType, text: string): Promise<void> {
    // Only the system clipboard exists here; an empty selection and `c` both mean it. (`p`, the
    // primary selection, has no web API and is left alone.)
    if ((selection as string) !== "" && (selection as string) !== "c") return Promise.resolve();
    return navigator.clipboard.writeText(text).catch(() => undefined);
  }
}

/**
 * The change's terminal: a pty attached to the change's tmux session, rendered by xterm.js in
 * the page itself.
 *
 * Which window you are in, and how to get to another, is the navigation column's job. This is
 * the terminal, the focus, and the new-window chord.
 *
 * The URL is fetched by the app on arrival rather than here, so opening the page does not wait
 * behind the dashboard's CLI calls for one of the browser's six connections.
 */
export function TerminalPane({
  changeId,
  url,
  error,
  visible,
  focusRequest,
  platform,
  onNewWindow,
  windows,
}: {
  changeId: string;
  url: string | null;
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
  const socket = useRef<WebSocket | null>(null);
  /** The URL the open socket belongs to: a different change needs a different pty. */
  const openedFor = useRef<string | null>(null);
  /** A resize that arrives while the socket is still connecting: sent as soon as it opens. */
  const pendingResize = useRef<{ cols: number; rows: number } | null>(null);
  /** Bumped when the terminal instance is recreated, so the socket effect reconnects after its
   * cleanup closed the old connection (a platform change, if one ever comes). */
  const [generation, setGeneration] = useState(0);

  // A terminal that was fine when the tab opened can lose its session while you watch it, the way
  // a killed tmux server does. The window list going empty and staying empty is what that looks
  // like from here; waiting a moment tells "starting" from "lost".
  const [lostWhileOpen, setLostWhileOpen] = useState(false);
  useEffect(() => {
    if (!visible || windows > 0) {
      setLostWhileOpen(false);
      return;
    }
    const timer = setTimeout(() => setLostWhileOpen(true), 5000);
    return () => clearTimeout(timer);
  }, [visible, windows]);

  // The xterm instance, once: it owns the screen for as long as the pane is mounted. The
  // session behind it is the socket's (below), so hiding the pane keeps the shells running.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      // tmux owns scrolling (mouse on), and it repaints in place rather than scrolling the outer
      // terminal: xterm's own scrollback is never what you scroll, and the scrollbar would only
      // be an empty bar down the right edge.
      scrollback: 0,
      fontSize: 13,
      // The terminal is the deepest surface the app has, and the sheet owns it: xterm takes the
      // background from the same `--well` token (apps/server/src/app-root/styles.css) rather than a second copy
      // of the colour here, which is the kind of pair that drifts.
      theme: { background: wellTone(), foreground: "#e6edf3" },
      // With tmux's mouse mode on, the mouse belongs to tmux and a plain drag never reaches
      // xterm: it is tmux's selection, which lands on the system clipboard on its own (the
      // addon loaded below). Option-drag hands it back to xterm for xterm's own selection, the
      // only way to get one on macOS.
      macOptionClickForcesSelection: platform === "mac",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // tmux sends its own copies — a drag, a double click, an explicit copy — to the terminal as
    // an OSC 52 sequence; xterm ignores it without this addon, which writes the system clipboard
    // (the tmux side is `set-clipboard on` in tmux.ts).
    term.loadAddon(new ClipboardAddon(undefined, new QuietClipboardProvider()));
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
    setGeneration((n) => n + 1);
    return () => {
      input.dispose();
      socket.current?.close();
      socket.current = null;
      openedFor.current = null;
      pendingResize.current = null;
      term.dispose();
      terminal.current = null;
      fitAddon.current = null;
    };
  }, [platform]);

  // One socket, when the terminal is first shown and the URL is known. The fit happens before
  // the connect: the first size the shell sees is the right one, so switching to the terminal
  // is not a resize every full-screen program has to redraw for.
  useLayoutEffect(() => {
    // Another change's URL (or none yet): the open pty belongs to the old change.
    if (socket.current && openedFor.current !== url) {
      socket.current.close();
      socket.current = null;
    }
    if (!url || !visible) return;
    const term = terminal.current;
    const fit = fitAddon.current;
    if (!term || !fit || !host.current) return;
    if (socket.current) return;
    fit.fit();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}${url}?cols=${term.cols}&rows=${term.rows}`);
    ws.onmessage = (event: MessageEvent) => {
      // Output only: the server never sends a control frame.
      if (typeof event.data === "string") term.write(event.data);
    };
    // A resize that happened while this socket was connecting was queued; the shell starts at
    // the size it now has.
    ws.onopen = () => {
      if (!pendingResize.current) return;
      ws.send(JSON.stringify({ type: "resize", ...pendingResize.current }));
      pendingResize.current = null;
    };
    // A socket that closes (its session died, the server restarted) is forgotten, so hiding and
    // showing the pane again reconnects to a fresh pty.
    ws.onclose = () => {
      if (socket.current === ws) socket.current = null;
      pendingResize.current = null;
    };
    socket.current = ws;
    openedFor.current = url;
    // Deliberately no cleanup: hiding the pane (the dashboard, another change's page) must keep
    // the tmux client attached, which is what leaves the shells running.
  }, [url, visible, generation]);

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

  // Middle-click pastes the system clipboard, the way a Linux terminal does. With mouse mode on
  // xterm would report the click to tmux, whose MouseDown2Pane pastes tmux's own buffer instead;
  // capture on the host stops the event before xterm's listener on the inner element.
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

  // The keys xterm cannot encode are sent by the page itself, and the clipboard chords are the
  // page's too. Capture phase, ahead of xterm's own textarea handler, which would send a plain
  // carriage return for the one and a control byte for the other.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onKey = (e: KeyboardEvent): void => {
      const term = terminal.current;
      if (!term) return;
      // Swallowed even when there is nothing to copy or paste: a Shift chord must never turn
      // into the control byte it would be without the Shift.
      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.code === "KeyC" || e.code === "KeyV")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.code === "KeyC") void copySelection(term);
        else void pasteClipboard(term);
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
    if (visible) terminal.current?.focus();
  }, [visible, url, focusRequest]);

  const onContextMenu = useCallback((e: ReactMouseEvent): void => {
    // A right click is tmux's: with mouse mode on, the pty reports it to the pane and tmux draws
    // its own menu in the grid. The browser does not know that happened and would show its own
    // over it regardless — there is nothing in a terminal to Inspect Element on, so it is
    // switched off rather than merely out of the way.
    e.preventDefault();
  }, []);

  return (
    <div className="terminal">
      {lostWhileOpen && (
        <div className="terminal-gone">
          The tmux session for this change is gone: the shells in it, and anything that was
          running in them, are lost. Reload this page to start a fresh session.
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {!url && !error && <p className="hint">starting terminal…</p>}
      {/* No tooltip: the window's own row already says which change's terminal this is, and a
          floating "terminal for …" over the grid is in the way of reading it. */}
      <div ref={host} className="terminal-screen" hidden={!url} onContextMenu={onContextMenu} />
    </div>
  );
}
