import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import { gatewayRoutes } from "../apps/server/src/gateway/routes.ts";
import { gatewaySockets, isGatewaySocket } from "../apps/server/src/gateway/server/index.ts";
import { serve, type ServerWebSocket, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { guard } from "../apps/server/src/capabilities/web.ts";
import { configPath, reloadConfigSync } from "../apps/server/src/workspace/server/index.ts";

/**
 * The gateway's transport, against a fake upstream rather than a real Corvi: the prefix is
 * stripped, the token is injected, the browser's credentials are not forwarded, a stream is
 * streamed, and a WebSocket is bridged both ways.
 */

/** A record of what the upstream saw, for the "what was forwarded" assertions. */
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };

let upstream: ReturnType<typeof createServer>;
let upstreamPort: number;
let guarded: Serving;
let redirectTarget: ReturnType<typeof createServer>;
let redirectHits: number;
let local: Serving;
let seen: Seen[];
let socketHeaders: IncomingHttpHeaders[];

const writeConfig = (value: unknown): void => {
  writeFileSync(configPath(), JSON.stringify(value));
  reloadConfigSync();
};

const localUrl = (path: string): string => new URL(path, local.url).toString();

const dispatch = {
  open: (ws: ServerWebSocket<unknown>) => {
    if (isGatewaySocket(ws.data)) gatewaySockets.open(ws as ServerWebSocket<never>);
  },
  message: (ws: ServerWebSocket<unknown>, message: string | Uint8Array) => {
    if (isGatewaySocket(ws.data)) gatewaySockets.message(ws as ServerWebSocket<never>, message);
  },
  close: (ws: ServerWebSocket<unknown>) => {
    if (isGatewaySocket(ws.data)) gatewaySockets.close(ws as ServerWebSocket<never>);
  },
};

beforeAll(async () => {
  seen = [];
  socketHeaders = [];
  redirectHits = 0;

  // A server that records being fetched: a redirect the gateway refused must never reach it.
  redirectTarget = createServer((_req, res) => {
    redirectHits += 1;
    res.writeHead(200);
    res.end("stolen");
  });
  await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", () => resolve()));
  const redirectPort = (redirectTarget.address() as AddressInfo).port;

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if ((req.url ?? "").startsWith("/api/sse")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: one\n\n");
        setTimeout(() => {
          res.write("data: two\n\n");
          res.end();
        }, 150);
        return;
      }
      if (req.url === "/api/boom") {
        res.writeHead(418, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "teapot" }));
        return;
      }
      if (req.url === "/api/set-cookie") {
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": "remote=1; Path=/" });
        res.end("ok");
        return;
      }
      if (req.url === "/api/redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${redirectPort}/stolen` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization ?? null,
          cookie: req.headers.cookie ?? null,
          body,
        }),
      );
    });
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (socket, req) => {
    socketHeaders.push(req.headers);
    socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  upstreamPort = (upstream.address() as AddressInfo).port;

  // A real `guard`ed upstream, so the browser-origin-header behaviour is proven against the
  // actual CSRF check rather than a permissive fake.
  guarded = await serve({
    port: 0,
    routes: guard({
      "/api/write": async (req: Request) => {
        const body = await req.text();
        return new Response(
          JSON.stringify({ ok: true, origin: req.headers.get("origin") ?? null, body }),
          { headers: { "content-type": "application/json" } },
        );
      },
    }),
  });

  writeConfig({
    workspaces: [
      {
        id: "remote-client",
        name: "Client",
        remote: { url: `http://127.0.0.1:${upstreamPort}`, workspace: "client", token: "remote-token" },
      },
      {
        id: "guarded",
        name: "Guarded",
        remote: { url: `http://127.0.0.1:${guarded.port}`, workspace: "w", token: "guarded-token" },
      },
      { id: "local", name: "Local" },
      { id: "bad", name: "Bad", remote: { url: "ftp://host", workspace: "w", token: "t" } },
    ],
  });

  local = await serve({
    port: 0,
    routes: gatewayRoutes,
    websocket: dispatch as never,
  });
});

afterAll(() => {
  local?.stop();
  guarded?.stop();
  upstream?.close();
  redirectTarget?.close();
});

test("a GET is proxied with the prefix stripped, the query kept, and the token injected", async () => {
  const response = await fetch(localUrl("remote/remote-client/api/changes?workspace=client&x=1"), {
    headers: { authorization: "Bearer browser-token", cookie: "corvi_device=browser-cookie" },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    method: string;
    url: string;
    authorization: string | null;
    cookie: string | null;
  };
  expect(body.method).toBe("GET");
  expect(body.url).toBe("/api/changes?workspace=client&x=1");
  // The remote's token replaces the browser's Authorization, and the browser's cookie is dropped.
  expect(body.authorization).toBe("Bearer remote-token");
  expect(body.cookie).toBeNull();
});

test("a POST forwards its body and method", async () => {
  const response = await fetch(localUrl("remote/remote-client/api/changes"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "remote change" }),
  });
  const body = (await response.json()) as { method: string; body: string };
  expect(body.method).toBe("POST");
  expect(body.body).toBe('{"title":"remote change"}');
});

test("the upstream's status and body come back, and Set-Cookie is dropped", async () => {
  const boom = await fetch(localUrl("remote/remote-client/api/boom"));
  expect(boom.status).toBe(418);
  expect(await boom.json()).toEqual({ error: "teapot" });

  const cookie = await fetch(localUrl("remote/remote-client/api/set-cookie"));
  expect(cookie.headers.get("set-cookie")).toBeNull();
  expect(await cookie.text()).toBe("ok");
});

test("an event stream streams in order, not buffered", async () => {
  const response = await fetch(localUrl("remote/remote-client/api/sse"));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const first = decoder.decode((await reader.read()).value);
  expect(first).toContain("data: one");
  // The second event is 150ms away: a buffering proxy would have it in the first chunk.
  expect(first).not.toContain("data: two");

  const second = decoder.decode((await reader.read()).value);
  expect(second).toContain("data: two");
  await reader.cancel();
});

test("a websocket upgrade bridges frames both ways with the bearer token", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${local.port}/remote/remote-client/api/chat`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  socket.send("hello remote");
  const reply = await new Promise<string>((resolve) => {
    socket.once("message", (data) => resolve(data.toString()));
  });
  expect(reply).toBe("echo:hello remote");
  expect(socketHeaders[0]?.authorization).toBe("Bearer remote-token");
  socket.close();
});

test("a browser-style write passes the remote's own origin guard", async () => {
  // What a same-origin fetch from the page carries: an Origin and Referer for the local origin,
  // plus the Sec-Fetch-* family. Forwarded as-is, the remote's `guard` 403s them.
  const origin = new URL(local.url).origin;
  const response = await fetch(localUrl("remote/guarded/api/write"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      referer: `${origin}/settings`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
    body: JSON.stringify({ written: true }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; origin: string | null; body: string };
  expect(body.ok).toBe(true);
  expect(body.body).toBe('{"written":true}');
  // The remote never saw the browser's origin claims.
  expect(body.origin).toBeNull();
});

test("a redirect from the remote is refused, not followed", async () => {
  const before = redirectHits;
  const response = await fetch(localUrl("remote/remote-client/api/redirect"), {
    redirect: "manual",
  });
  expect(response.status).toBe(502);
  // The off-origin target was never fetched with the token attached.
  expect(redirectHits).toBe(before);
});

test("an unknown, local, or non-http(s) source does not proxy", async () => {
  expect((await fetch(localUrl("remote/nope/api/x"))).status).toBe(404);
  expect((await fetch(localUrl("remote/local/api/x"))).status).toBe(404);
  // A scheme the gateway must never fetch is refused, not attempted.
  expect((await fetch(localUrl("remote/bad/api/x"))).status).toBe(502);
});
