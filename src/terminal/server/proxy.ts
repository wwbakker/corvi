/**
 * The terminal is served from IWE's own origin, proxying ttyd, for two reasons.
 *
 * A cross-origin frame is a closed box: the page cannot focus it properly, and cannot correct
 * what the browser sends. xterm.js encodes Enter as a plain carriage return whatever modifier is
 * held — there is no legacy encoding for shift-Enter, and it implements neither of the modern
 * ones — so the shift is lost between your hand and the shell. Same-origin, a small script
 * injected into ttyd's page sends the CSI u sequence for those keys instead — and a small style
 * takes away xterm's empty scrollbar, which its own stylesheet keeps for good (withPageFixes).
 */
import type { Server, ServerWebSocket } from "bun";
import { isNewWindowKey, type Platform } from "../client/newWindowKey.ts";

/** ttyd's own protocol: a client frame is one byte of command, then the payload. */
const INPUT = "0".charCodeAt(0);

/** Keys the browser cannot encode by itself, as CSI u: `ESC [ <code> ; <modifier> u`. Modifiers
 * are a bitfield above 1: shift 1, alt 2, ctrl 4. */
const KEYS = `
  const csi = { "Enter:shift": "\\x1b[13;2u", "Enter:ctrl": "\\x1b[13;5u", "Enter:shift-ctrl": "\\x1b[13;6u" };
`;

/** The script injected into ttyd's page. It captures the WebSocket ttyd opens, and sends the
 * sequences itself for the keys ttyd's terminal would flatten.
 *
 * The platform is baked in at serve time: the shell on the other end of the socket lives on the
 * machine the server does, so it is the server's platform that decides which chord opens a
 * window. The key test itself comes from terminal/client/newWindowKey.ts, embedded here as
 * source so page and shim cannot drift apart. */
export const keysScript = (platform: Platform): string => `
(() => {
  ${KEYS}
  let socket = null;
  const Original = window.WebSocket;
  // ttyd opens exactly one socket, on load; wrapping the constructor is how we get to it without
  // depending on anything ttyd chooses to expose.
  window.WebSocket = function (...args) {
    const ws = new Original(...args);
    socket = ws;
    window.__ttydSocket = ws; // diagnostics: the page (and a probing parent) can reach ttyd's socket
    return ws;
  };
  window.WebSocket.prototype = Original.prototype;
  Object.assign(window.WebSocket, Original);

  const send = (text) => {
    if (!socket || socket.readyState !== 1) return false;
    const bytes = new TextEncoder().encode(text);
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = ${INPUT};
    frame.set(bytes, 1);
    socket.send(frame);
    return true;
  };

  const isNewWindowKey = ${isNewWindowKey};
  const IWE_PLATFORM = "${platform}";

  // The terminal fills the page, so this is where the new-window chord is pressed; the page
  // around the frame is the one that can open a window, hence the message rather than a call.
  window.addEventListener("keydown", (e) => {
    if (!isNewWindowKey(e, IWE_PLATFORM)) return;
    e.preventDefault();
    parent.postMessage({ iwe: "new-window" }, location.origin);
  });

  // A right click is tmux's: with mouse mode on, ttyd reports it to the pane and tmux draws its
  // own menu in the grid. The browser does not know that happened and shows its own menu over
  // it regardless, which is the second, unwanted one — there is nothing in a terminal to Inspect
  // Element on, so it is switched off rather than merely out of the way.
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  // Capture phase: xterm.js listens on the textarea and would otherwise send its carriage
  // return first.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.metaKey || e.isComposing) return;
      const held = [e.shiftKey && "shift", e.ctrlKey && "ctrl"].filter(Boolean).join("-");
      const sequence = csi["Enter:" + held];
      if (!sequence) return; // plain Enter, or alt-Enter, which xterm handles correctly
      if (send(sequence)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
})();
`;

/** ttyd's page, with the keys script and one style added.
 *
 * The style is xterm's own scrollbar. `.xterm-viewport` is `overflow-y: scroll` in xterm's
 * stylesheet whatever the scrollback is, and on a machine that shows scrollbars always that is a
 * pale bar down the right of the terminal — empty, since tmux owns scrolling (`mouse on`) and the
 * terminal is started with no scrollback of its own. Hiding it is the only way to be rid of it;
 * changing the scrollback alone leaves the bar's width reserved. */
export const withPageFixes = (html: string): string =>
  html.replace(
    "</head>",
    `<style>.xterm .xterm-viewport{overflow-y:hidden}</style><script src="/terminal-keys.js"></script></head>`,
  );

type Bridge = { upstream?: WebSocket; queue: (string | Uint8Array)[]; port: number };

/**
 * Pass a browser socket through to ttyd's. The queue exists because the browser's socket is open
 * before ours to ttyd is: ttyd's client sends its authentication frame immediately, and dropping
 * it leaves a terminal that never starts.
 */
export const bridge = {
  open(ws: ServerWebSocket<Bridge>): void {
    const upstream = new WebSocket(`ws://127.0.0.1:${ws.data.port}/ws`, ["tty"]);
    upstream.binaryType = "arraybuffer";
    upstream.onopen = () => {
      for (const message of ws.data.queue) upstream.send(message);
      ws.data.queue.length = 0;
    };
    upstream.onmessage = (e: MessageEvent) => ws.send(e.data as ArrayBuffer);
    upstream.onclose = () => ws.close();
    upstream.onerror = () => ws.close();
    ws.data.upstream = upstream;
  },

  message(ws: ServerWebSocket<Bridge>, message: string | Uint8Array): void {
    if (process.env.IWE_TRACE) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      console.log("[bridge] from browser:", JSON.stringify(text));
    }
    const upstream = ws.data.upstream;
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
    else ws.data.queue.push(message);
  },

  close(ws: ServerWebSocket<Bridge>): void {
    ws.data.upstream?.close();
  },
};

/** Proxy one request to the ttyd serving this change. */
export async function proxyToTtyd(req: Request, port: number, rest: string): Promise<Response> {
  const url = new URL(req.url);
  const upstream = await fetch(`http://127.0.0.1:${port}/${rest}${url.search}`, {
    method: req.method,
    body: req.body,
  });
  const headers = new Headers(upstream.headers);
  // fetch decoded the body already; announcing it as gzip would make the browser fail to read it.
  headers.delete("content-encoding");
  headers.delete("content-length");
  const isPage = (headers.get("content-type") ?? "").startsWith("text/html");
  if (!isPage) return new Response(upstream.body, { status: upstream.status, headers });
  return new Response(withPageFixes(await upstream.text()), {
    status: upstream.status,
    headers,
  });
}

export type { Bridge, Server };
