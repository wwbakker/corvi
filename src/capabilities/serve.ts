/**
 * The server, on `node:http`.
 *
 * `Bun.serve` gave the app three things: a route table (`:param` and `*` patterns, a handler per
 * method, `req.params`), Request/Response handlers with streaming bodies, and WebSocket upgrades
 * with per-connection data. The app runs on Electron's Node now (docs/decisions/node-server.md),
 * so this is the same surface over `node:http` and `ws` — and the route tables, the proxy and
 * the page do not change.
 *
 * The route tables are still typed with Bun's route types (`src/capabilities/web.ts`): those are
 * erased at run time and are the only thing that keeps `req.params` typed through twenty route
 * files. This module is the runtime half.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";

/** A live connection, with the per-connection data the route's upgrade attached to it — the
 * shape `Bun.serve`'s `ServerWebSocket<T>` had, so the ttyd proxy's `ws.data` still answers. */
export type ServerWebSocket<Data> = WsSocket & { data: Data };

/** What a handler's second argument offers: the one upgrade call the terminal proxy makes. */
export type Server = {
  upgrade: (request: Request, options?: { data?: unknown }) => boolean;
};

type Handler = (
  request: Request,
  server: Server,
) => Response | undefined | Promise<Response | undefined>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** The shape `guard` (src/capabilities/web.ts) preserves from Bun's route types at compile time;
 * here it is only asked at run time, the same way the guard asks. */
const isMethodMap = (value: object): boolean =>
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => (METHODS as readonly string[]).includes(key));

type Route = {
  value: unknown;
  regex: RegExp;
  /** The parameter names, in the order their capture groups appear; `*` is the wildcard. */
  keys: string[];
  /** How many literal segments: what decides which route wins when two could match. */
  score: number;
};

const escape = (segment: string): string => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compile the route table once: a pattern is static segments, `:params` and one trailing `*`. */
const compile = (pattern: string, value: unknown): Route => {
  const keys: string[] = [];
  let score = 0;
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment === "*") {
        keys.push("*");
        return "(.*)";
      }
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      score++;
      return escape(segment);
    })
    .join("/");
  return { value, regex: new RegExp(`^${source}/?$`), keys, score };
};

/** Most specific first: more literal segments win, and a wildcard is the last resort. Ties keep
 * the table's own order, so a table that is unambiguous stays that way. */
const compileAll = (routes: Record<string, unknown>): Route[] =>
  Object.entries(routes)
    .map(([pattern, value], index) => ({ route: compile(pattern, value), index }))
    .sort((a, b) => b.route.score - a.route.score || a.index - b.index)
    .map(({ route }) => route);

type Match = { handler?: Handler; params: Record<string, string>; allowed: string[] };

const match = (routes: Route[], method: string, pathname: string): Match => {
  for (const route of routes) {
    const found = route.regex.exec(pathname);
    if (!found) continue;
    // Bun hands the parameters over raw, not decoded: the terminal route does its own
    // decodeURIComponent, and the file routes pass them through basename().
    const params: Record<string, string> = {};
    route.keys.forEach((key, i) => {
      params[key] = found[i + 1] ?? "";
    });
    const value = route.value;
    if (typeof value === "function") return { handler: value as Handler, params, allowed: [] };
    if (value && typeof value === "object" && isMethodMap(value)) {
      const byMethod = value as Record<string, Handler>;
      const allowed = Object.keys(byMethod);
      if (method in byMethod) return { handler: byMethod[method], params, allowed };
      return { params, allowed }; // a 405, with what was allowed
    }
  }
  return { params: {}, allowed: [] };
};

const headersOf = (req: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(key, one);
    else if (value !== undefined) headers.append(key, value);
  }
  return headers;
};

const toRequest = (req: IncomingMessage, url: string): Request => {
  const method = req.method ?? "GET";
  const withBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers: headersOf(req),
    body: withBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
    // Required by Node for a streaming request body; absent from the DOM type.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
};

const attachParams = (request: Request, params: Record<string, string>): Request => {
  // Exactly what Bun's own request carried: a property the handlers read as `req.params`.
  Object.assign(request, { params });
  return request;
};

const writeResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") {
      const existing = headers[key];
      headers[key] = Array.isArray(existing) ? [...existing, value] : [value];
    } else headers[key] = value;
  });
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as never), res);
  } catch {
    // The client went away (a closed tab, a killed terminal frame): the response is over, and
    // there is nobody to tell.
  }
};

/** An upgrade-path answer that is not an upgrade (404 "no terminal for this change") has no
 * ServerResponse to write to: the request never became one. Write it to the socket as it is. */
const writeRaw = async (socket: Socket, response: Response): Promise<void> => {
  const body = Buffer.from(await response.arrayBuffer());
  socket.write(`HTTP/1.1 ${response.status} ${response.statusText || "OK"}\r\n`);
  response.headers.forEach((value, key) => socket.write(`${key}: ${value}\r\n`));
  socket.write(`content-length: ${body.length}\r\nconnection: close\r\n\r\n`);
  socket.end(body);
};

export type WebSocketHandlers<Data> = {
  open?: (socket: ServerWebSocket<Data>) => void;
  /** Bun's own shape: text as a string, binary as a Uint8Array. */
  message?: (socket: ServerWebSocket<Data>, message: string | Uint8Array) => void;
  close?: (socket: ServerWebSocket<Data>) => void;
};

export type ServeOptions<Data> = {
  port: number;
  hostname?: string;
  routes: Record<string, unknown>;
  websocket?: WebSocketHandlers<Data>;
};

export type Serving = { url: URL; port: number; stop: () => void };

/** The URL a request arrived on: what the Response's `url` is built from. */
const requestUrl = (req: IncomingMessage): string =>
  `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;

/** A frame as the proxy expects it: text as it is, binary as bytes over a plain ArrayBuffer. */
const frameOf = (data: RawData, isBinary: boolean): string | Uint8Array => {
  if (!isBinary) return data.toString();
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(Buffer.concat(data));
};

export const serve = async <Data>(options: ServeOptions<Data>): Promise<Serving> => {
  const routes = compileAll(options.routes);
  const wss = new WebSocketServer({ noServer: true });

  /** On a plain request there is nothing to upgrade: Bun's `srv.upgrade` answered false there
   * too, and the terminal route turns that into its 400. */
  const noUpgrade: Server = { upgrade: () => false };

  const server = createServer((req, res) => {
    void (async () => {
      const request = toRequest(req, requestUrl(req));
      const found = match(routes, request.method, new URL(request.url).pathname);
      if (!found.handler) {
        res.writeHead(found.allowed.length ? 405 : 404, {
          ...(found.allowed.length ? { allow: found.allowed.join(", ") } : {}),
        });
        res.end();
        return;
      }
      const response = await found.handler(attachParams(request, found.params), noUpgrade);
      if (!response) {
        res.writeHead(404);
        res.end();
        return;
      }
      await writeResponse(res, response);
    })().catch((error: unknown) => {
      console.error("request failed:", error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // The upgrade is routed before the handshake, exactly as Bun routed it: the terminal route
  // resolves the change's ttyd port (an await, so the socket stays open) and then upgrades.
  server.on("upgrade", (req, socket, head) => {
    // Node types the upgrade socket as a Duplex; it is a net.Socket, which is what the
    // handshake and the raw non-upgrade answer both need.
    const raw = socket as Socket;
    void (async () => {
      const request = toRequest(req, requestUrl(req));
      const found = match(routes, request.method, new URL(request.url).pathname);
      if (!found.handler) {
        raw.destroy();
        return;
      }
      let upgraded = false;
      const perConnection: Server = {
        upgrade: (_request, upgradeOptions) => {
          if (upgraded) return false;
          upgraded = true;
          wss.handleUpgrade(req, raw, head, (ws) => {
            const connection = ws as ServerWebSocket<Data>;
            connection.data = upgradeOptions?.data as Data;
            ws.on("message", (data: RawData, isBinary: boolean) =>
              options.websocket?.message?.(connection, frameOf(data, isBinary)),
            );
            ws.on("close", () => options.websocket?.close?.(connection));
            options.websocket?.open?.(connection);
          });
          return true;
        },
      };
      const response = await found.handler(attachParams(request, found.params), perConnection);
      if (!upgraded) {
        if (response) await writeRaw(raw, response);
        else raw.destroy();
      }
    })().catch((error: unknown) => {
      console.error("upgrade failed:", error);
      raw.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const hostname = options.hostname ?? "127.0.0.1";
  return {
    url: new URL(`http://${hostname}:${port}/`),
    port,
    stop: () => {
      wss.close();
      server.close();
    },
  };
};
