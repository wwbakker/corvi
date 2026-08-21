/**
 * The terminal is served from IWE's own origin, proxying ttyd, for two reasons.
 *
 * A cross-origin frame is a closed box: the page cannot focus it properly, and cannot correct
 * what the browser sends. xterm.js encodes Enter as a plain carriage return whatever modifier is
 * held — there is no legacy encoding for shift-Enter, and it implements neither of the modern
 * ones — so the shift is lost between your hand and the shell. Same-origin, a small script
 * injected into ttyd's page sends the CSI u sequence for those keys instead.
 */
import type { Server, ServerWebSocket } from "bun";

/** ttyd's own protocol: a client frame is one byte of command, then the payload. */
const INPUT = "0".charCodeAt(0);

/** Keys the browser cannot encode by itself, as CSI u: `ESC [ <code> ; <modifier> u`. Modifiers
 * are a bitfield above 1: shift 1, alt 2, ctrl 4. */
const KEYS = `
  const csi = { "Enter:shift": "\\x1b[13;2u", "Enter:ctrl": "\\x1b[13;5u", "Enter:shift-ctrl": "\\x1b[13;6u" };
`;

/** The script injected into ttyd's page. It captures the WebSocket ttyd opens, and sends the
 * sequences itself for the keys ttyd's terminal would flatten. */
export const keysScript = `
(() => {
  ${KEYS}
  let socket = null;
  const Original = window.WebSocket;
  // ttyd opens exactly one socket, on load; wrapping the constructor is how we get to it without
  // depending on anything ttyd chooses to expose.
  window.WebSocket = function (...args) {
    const ws = new Original(...args);
    socket = ws;
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

/** ttyd's page, with the script added. Nothing else about it is touched. */
export const withKeysScript = (html: string): string =>
  html.replace("</head>", `<script src="/terminal-keys.js"></script></head>`);

type Bridge = { upstream?: WebSocket; queue: (string | Uint8Array)[]; port: number };

/**
 * Pass a browser socket through to ttyd's. The queue exists because the browser's socket is open
 * before ours to ttyd is: ttyd's client sends its authentication frame immediately, and dropping
 * it leaves a terminal that never starts.
 */
export const bridge = {
  open(ws: ServerWebSocket<Bridge>) {
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

  message(ws: ServerWebSocket<Bridge>, message: string | Uint8Array) {
    if (process.env.IWE_TRACE) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      console.log("[bridge] from browser:", JSON.stringify(text));
    }
    const upstream = ws.data.upstream;
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
    else ws.data.queue.push(message);
  },

  close(ws: ServerWebSocket<Bridge>) {
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
  return new Response(withKeysScript(await upstream.text()), {
    status: upstream.status,
    headers,
  });
}

export type { Bridge, Server };
