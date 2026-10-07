import { afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { powerRoutes } from "../apps/server/src/power/routes.ts";
import { fanOut } from "../apps/server/src/power/server/fanout.ts";
import { configPath, reloadConfigSync } from "../apps/server/src/workspace/server/index.ts";

/**
 * The power fan-out, against a fake upstream: every outcome becomes one per-target result, the
 * workspace's device token rides along, and a remote's answer is reported under the source id the
 * origin selected. Nothing here is a real Corvi.
 */

type Seen = { method: string; url: string; auth: string | undefined; body: string };

type Upstream = {
  readonly url: string;
  readonly seen: Seen[];
  readonly answer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
  readonly stop: () => void;
};

const fakeUpstream = async (): Promise<Upstream> => {
  const seen: Seen[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ source: "", status: "armed" }] }));
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    answer: (next) => {
      handler = next;
    },
    stop: () => server.close(),
  };
};

const writeConfig = (workspaces: unknown[]): void => {
  writeFileSync(configPath(), JSON.stringify({ workspaces }));
  reloadConfigSync();
};

const remoteWorkspace = (id: string, url: string, token = "remote-token"): unknown => ({
  id,
  name: id,
  remote: { url, workspace: id, token },
});

let upstreams: Upstream[];

const newUpstream = async (): Promise<Upstream> => {
  const upstream = await fakeUpstream();
  upstreams.push(upstream);
  return upstream;
};

beforeAll(() => {
  upstreams = [];
});

afterEach(() => {
  for (const upstream of upstreams) upstream.stop();
  upstreams = [];
});

test("an armed remote answers under the requested source, with the token and the local target", async () => {
  const upstream = await newUpstream();
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);

  expect(await fanOut("arm", ["remote-client"])).toEqual([
    { source: "remote-client", status: "armed" },
  ]);
  expect(upstream.seen).toHaveLength(1);
  const seen = upstream.seen[0]!;
  expect(seen.method).toBe("POST");
  expect(seen.url).toBe("/api/power/arm");
  expect(seen.auth).toBe("Bearer remote-token");
  expect(JSON.parse(seen.body)).toEqual({ targets: [""] });
});

test("a disarm fans out to the disarm route and reports disarmed", async () => {
  const upstream = await newUpstream();
  upstream.answer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ source: "", status: "disarmed" }] }));
  });
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);

  expect(await fanOut("disarm", ["remote-client"])).toEqual([
    { source: "remote-client", status: "disarmed" },
  ]);
  expect(upstream.seen[0]?.url).toBe("/api/power/disarm");
});

test("a 404 is an older server without the route: unsupported", async () => {
  const upstream = await newUpstream();
  upstream.answer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);
  expect(await fanOut("arm", ["remote-client"])).toEqual([
    {
      source: "remote-client",
      status: "unsupported",
      detail: "the remote server has no power route",
    },
  ]);
});

test("a 401 is refused", async () => {
  const upstream = await newUpstream();
  upstream.answer((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);
  expect((await fanOut("arm", ["remote-client"]))[0]).toMatchObject({
    source: "remote-client",
    status: "refused",
    detail: "the remote answered 401",
  });
});

test("a redirect is refused, not followed", async () => {
  const upstream = await newUpstream();
  upstream.answer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:1/stolen" });
    res.end();
  });
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);
  expect(await fanOut("arm", ["remote-client"])).toEqual([
    { source: "remote-client", status: "refused", detail: "the remote redirected the request" },
  ]);
});

test("a malformed 200 is refused", async () => {
  const upstream = await newUpstream();
  upstream.answer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not a power response");
  });
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);
  expect((await fanOut("arm", ["remote-client"]))[0]).toMatchObject({
    source: "remote-client",
    status: "refused",
  });
});

test("a 200 that never names this target is refused", async () => {
  const upstream = await newUpstream();
  upstream.answer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ source: "someone-else", status: "armed" }] }));
  });
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);
  expect((await fanOut("arm", ["remote-client"]))[0]).toMatchObject({
    source: "remote-client",
    status: "refused",
  });
});

test("a missing workspace and an invalid url are reported, not fetched", async () => {
  writeConfig([remoteWorkspace("invalid", "ftp://example.test")]);
  expect(await fanOut("arm", ["ghost"])).toEqual([
    { source: "ghost", status: "unsupported", detail: "no such remote workspace" },
  ]);
  expect(await fanOut("arm", ["invalid"])).toEqual([
    {
      source: "invalid",
      status: "refused",
      detail: "the remote workspace's url is not http or https",
    },
  ]);
});

test("a connection refused is unreachable", async () => {
  // A free port, closed again: nothing is listening where the config points.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  writeConfig([remoteWorkspace("down", `http://127.0.0.1:${port}`)]);

  expect((await fanOut("arm", ["down"]))[0]).toMatchObject({
    source: "down",
    status: "unreachable",
  });
});

test("a hung remote is cut off by the timeout and reads unreachable", async () => {
  const upstream = await newUpstream();
  upstream.answer(() => {
    // Never respond: only the request's own timeout can end this.
  });
  writeConfig([remoteWorkspace("slow", upstream.url)]);

  expect((await fanOut("arm", ["slow"], { timeoutMs: 50 }))[0]).toMatchObject({
    source: "slow",
    status: "unreachable",
  });
});

test("one unavailable remote does not fail the others", async () => {
  const upstream = await newUpstream();
  writeConfig([remoteWorkspace("up", upstream.url)]);
  expect(await fanOut("arm", ["up", "ghost"])).toEqual([
    { source: "up", status: "armed" },
    { source: "ghost", status: "unsupported", detail: "no such remote workspace" },
  ]);
});

/** Call one guarded power route as a same-site request, as the page would. */
const postRoute = async (path: string, body: unknown): Promise<unknown> => {
  const table = powerRoutes as unknown as Record<
    string,
    { POST: (req: Request, srv: unknown) => Promise<Response> }
  >;
  const response = await table[path]!.POST(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
  );
  return response.json();
};

test("a 200 whose body stalls is unreachable, not a malformed answer", async () => {
  const upstream = await newUpstream();
  upstream.answer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{ "results": [');
    // Never end: the headers arrived, the body does not finish, and the timeout must win.
  });
  writeConfig([remoteWorkspace("slow", upstream.url)]);

  expect((await fanOut("arm", ["slow"], { timeoutMs: 50 }))[0]).toMatchObject({
    source: "slow",
    status: "unreachable",
  });
});

test("duplicate targets get one result each while the remote is asked once", async () => {
  const upstream = await newUpstream();
  writeConfig([remoteWorkspace("remote-client", upstream.url)]);

  expect(await postRoute("/api/power/arm", { targets: ["remote-client", "remote-client"] })).toEqual({
    results: [
      { source: "remote-client", status: "armed" },
      { source: "remote-client", status: "armed" },
    ],
  });
  expect(upstream.seen).toHaveLength(1);
});
