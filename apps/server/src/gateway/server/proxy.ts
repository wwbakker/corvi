/** The gateway's transport: carry a request to a remote workspace's server under
 * `/remote/<source>/…`, injecting that workspace's device token.
 *
 * The page keeps its single local origin and knows nothing about the remote's credential: the
 * token lives in the config and is added here. The remote's responses are streamed back
 * unchanged (minus the headers a proxy owns), so SSE and large bodies are not buffered.
 */
import { type RawData, WebSocket } from "ws";

import { runtimeConfig } from "../../capabilities/runtime.ts";
import { frameOf, type Server, type ServerWebSocket } from "../../capabilities/serve.ts";

/** A remote workspace's target: where it lives and the token this client presents there. */
export type RemoteTarget = { readonly baseUrl: string; readonly token?: string };

/** What resolving a source found: a target, no such remote workspace, or a remote whose url is
 * not a scheme this gateway will fetch. */
export type ResolvedRemote =
  | { readonly kind: "ok"; readonly target: RemoteTarget }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

const parseHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** Resolve a source id to its remote target. Unknown, local, or a source with no `remote` is
 * `missing`; a url that is not http(s) is `invalid`. The scheme is checked here, before any
 * fetch, because a hand-edited file can carry anything. */
export const resolveRemote = (source: string): ResolvedRemote => {
  const workspace = runtimeConfig().workspaces.find((candidate) => candidate.id === source);
  const remote = workspace?.remote;
  if (remote === undefined) return { kind: "missing" };
  if (parseHttpUrl(remote.url) === undefined) return { kind: "invalid" };
  return {
    kind: "ok",
    target: {
      baseUrl: remote.url.replace(/\/+$/, ""),
      ...(remote.token === undefined ? {} : { token: remote.token }),
    },
  };
};

/** The upstream URL for the prefix-stripped path and the original query. */
export const upstreamUrl = (target: RemoteTarget, rest: string, search: string): URL => {
  const url = new URL(`${target.baseUrl}/${rest}`);
  url.search = search;
  return url;
};

/** Statuses `fetch` would follow; the gateway refuses them instead. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The headers a proxy owns and never forwards. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** The extra headers the client named in its own `Connection` header, which are hop-by-hop too. */
const namedByConnection = (headers: Headers): Set<string> => {
  const named = new Set<string>();
  const connection = headers.get("connection");
  if (connection !== null) {
    for (const part of connection.split(",")) {
      if (part.trim() !== "") named.add(part.trim().toLowerCase());
    }
  }
  return named;
};

/** What the upstream sees: the client's headers minus the hop-by-hop ones, `Host`, and the
 * browser's own credentials, with the remote's bearer token in their place. The body is
 * re-streamed, so `content-length` is left to the fetch to recompute. */
export const forwardedRequestHeaders = (req: Request, token: string | undefined): Headers => {
  const headers = new Headers();
  const named = namedByConnection(req.headers);
  for (const [key, value] of req.headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    if (lower === "host" || lower === "authorization" || lower === "cookie") continue;
    if (lower === "content-length") continue;
    // The browser's origin claims describe the local page, not the remote one. Forwarding them
    // would make the remote's own `sameSite` guard 403 every browser write; the gateway is
    // already guarded on its own hop and carries the token, so the remote's guard is redundant.
    if (lower === "origin" || lower === "referer" || lower.startsWith("sec-fetch-")) continue;
    headers.append(key, value);
  }
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return headers;
};

/** What the page sees: the upstream's headers minus the hop-by-hop ones, `Set-Cookie` (the local
 * page's cookie is its own device token), and the framing headers. `content-encoding` goes too:
 * `fetch` decodes the body it hands back, so the encoding header would only describe bytes that
 * are no longer there. */
export const forwardedResponseHeaders = (upstream: Headers): Headers => {
  const headers = new Headers();
  for (const [key, value] of upstream) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "set-cookie" || lower === "content-length" || lower === "content-encoding") continue;
    headers.append(key, value);
  }
  return headers;
};

/** Forward one HTTP request and stream the answer back. Cancellation travels both ways: the
 * request's signal (the client hanging up) aborts the upstream fetch. */
export const proxyRequest = async (
  req: Request,
  target: RemoteTarget,
  rest: string,
): Promise<Response> => {
  const url = upstreamUrl(target, rest, new URL(req.url).search);
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : req.body;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers: forwardedRequestHeaders(req, target.token),
      signal: req.signal,
      // Never let a configured remote redirect the gateway to another origin with the token
      // attached: that is an SSRF pivot.
      redirect: "manual",
      ...(body === undefined ? {} : { body, duplex: "half" as const }),
    });
  } catch (error) {
    // A client that hung up is not a gateway failure: let the abort travel out.
    if (req.signal.aborted) throw error;
    return new Response("the remote server could not be reached", { status: 502 });
  }
  if (REDIRECT_STATUSES.has(upstream.status)) {
    void upstream.body?.cancel().catch(() => undefined);
    return new Response("the remote redirected the gateway; redirects are not followed", {
      status: 502,
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardedResponseHeaders(upstream.headers),
  });
};

/** A bridge is closed rather than buffering past this much to its slower side. */
const MAX_BACKPRESSURE_BYTES = 1 << 20;

/** What a bridged socket carries: the upstream client, the frames that arrived before the local
 * side was ready, and the local side once it is. */
export type GatewayBridge = {
  readonly upstream: WebSocket;
  readonly pending: Array<string | Uint8Array>;
  pendingBytes: number;
  local?: {
    send: (frame: string | Uint8Array) => void;
    close: () => void;
    readonly bufferedAmount?: number;
  };
  closed: boolean;
};

const frameSize = (frame: string | Uint8Array): number =>
  typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;

/** Forward one upstream frame to the local side, closing the bridge when either buffer would
 * grow past the bound rather than letting a slow peer exhaust the server. */
const toLocal = (bridge: GatewayBridge, frame: string | Uint8Array): void => {
  const size = frameSize(frame);
  const local = bridge.local;
  if (
    bridge.pendingBytes + size > MAX_BACKPRESSURE_BYTES ||
    (local?.bufferedAmount ?? 0) > MAX_BACKPRESSURE_BYTES
  ) {
    bridge.closed = true;
    local?.close();
    bridge.upstream.close();
    return;
  }
  if (local === undefined) {
    bridge.pending.push(frame);
    bridge.pendingBytes += size;
    return;
  }
  local.send(frame);
};

/** The per-connection data a gateway upgrade attaches to the local socket. */
export type GatewaySocket = { readonly gateway: GatewayBridge };

/** Whether a connection is a gateway bridge rather than a terminal session. */
export const isGatewaySocket = (data: unknown): data is GatewaySocket =>
  typeof data === "object" && data !== null && "gateway" in data;

/** The WebSocket handlers `server.ts` dispatches to for a gateway socket: frames flow both ways,
 * and either side's close closes the other. */
export const gatewaySockets = {
  open(ws: ServerWebSocket<GatewaySocket>): void {
    const bridge = ws.data.gateway;
    if (bridge.closed) {
      ws.close();
      return;
    }
    bridge.local = ws;
    for (const frame of bridge.pending.splice(0)) ws.send(frame);
    bridge.pendingBytes = 0;
  },
  message(ws: ServerWebSocket<GatewaySocket>, message: string | Uint8Array): void {
    const { upstream } = ws.data.gateway;
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (upstream.bufferedAmount > MAX_BACKPRESSURE_BYTES) {
      ws.data.gateway.closed = true;
      ws.close();
      upstream.close();
      return;
    }
    upstream.send(typeof message === "string" ? message : Buffer.from(message));
  },
  close(ws: ServerWebSocket<GatewaySocket>): void {
    ws.data.gateway.upstream.close();
  },
};

/** Bridge a WebSocket upgrade to the remote's socket. The upstream is opened before the local
 * side upgrades, so a refusal (a non-101) still comes back as an HTTP answer where it can. */
export const bridgeUpgrade = async (
  req: Request,
  srv: Server,
  target: RemoteTarget,
  rest: string,
): Promise<Response | undefined> => {
  const url = upstreamUrl(target, rest, new URL(req.url).search);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(url, {
    headers: target.token === undefined ? {} : { authorization: `Bearer ${target.token}` },
  });
  const opened = await new Promise<"open" | number>((resolve) => {
    upstream.once("open", () => resolve("open"));
    upstream.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 502);
    });
    upstream.once("error", () => resolve(502));
  });
  if (opened !== "open") {
    upstream.terminate();
    return new Response(`the remote refused the socket (${opened})`, { status: 502 });
  }

  const bridge: GatewayBridge = { upstream, pending: [], pendingBytes: 0, closed: false };
  // The listeners are attached before the local upgrade, so a frame the remote sent on connect
  // is buffered rather than lost.
  upstream.on("message", (data: RawData, isBinary: boolean) => {
    toLocal(bridge, frameOf(data, isBinary));
  });
  upstream.on("close", () => {
    bridge.closed = true;
    bridge.local?.close();
  });
  upstream.on("error", () => {
    bridge.closed = true;
    bridge.local?.close();
  });

  if (srv.upgrade(req, { data: { gateway: bridge } })) return undefined;
  upstream.close();
  return new Response("the websocket upgrade failed", { status: 400 });
};
