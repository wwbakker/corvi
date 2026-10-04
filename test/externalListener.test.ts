import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket } from "ws";

import { instanceRecords } from "../apps/cli/src/discovery.ts";
import { removeInstanceRecord, writeInstanceRecord } from "../apps/server/src/app-root/instance.ts";
import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { runtimeRedeemLimiter, setRuntime } from "../apps/server/src/capabilities/runtime.ts";
import { devicesRoutes } from "../apps/server/src/devices/routes.ts";
import {
  authorizeExternalRequest,
  createPairingCode,
  createRedeemLimiter,
  DEVICE_COOKIE,
  redeemPairingCode,
  revokeDevice,
  type RedeemLimiter,
} from "../apps/server/src/devices/server/index.ts";
import { problems } from "../apps/server/src/settings/server/index.ts";
import { configPath, reloadConfigSync, runtimeConfig } from "../apps/server/src/workspace/server/index.ts";
import { runEffect, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";

/**
 * The external listener and its token enforcement.
 *
 * The local listener is loopback-only and tokenless. The external listener is loopback too but is
 * published to the tailnet, so every `/api/*` request must present a valid device token — the
 * gateway/CLI as a bearer, the page as an HttpOnly cookie — except the redeem bootstrap. These
 * tests drive a real `serve` listener so the authorize hook is exercised where it runs, including
 * the `Set-Cookie` round trip and the WebSocket upgrade's front door.
 */

type UpgradeServer = { upgrade: (request: Request, options?: { data?: unknown }) => boolean };

const routes: Record<string, unknown> = {
  ...devicesRoutes,
  "/": () => new Response("<!doctype html><title>corvi</title>", { headers: { "content-type": "text/html" } }),
  // A stand-in for the terminal socket route: it upgrades, so the external listener's authorize
  // hook has an upgrade to refuse or allow.
  "/api/socket": (req: Request, srv: UpgradeServer) =>
    srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 }),
};
const websocket = { open: (socket: { send: (data: string) => void }) => socket.send("ready") };

let local: Serving;
let external: Serving;

beforeAll(async () => {
  local = await serve({ port: 0, routes, websocket });
  external = await serve({ port: 0, routes, websocket, authorize: authorizeExternalRequest });
});

afterAll(() => {
  local?.stop();
  external?.stop();
});

const url = (server: Serving, path: string): URL => new URL(path, server.url);

const pair = async (name: string): Promise<{ id: string; token: string }> => {
  const code = await runEffect(createPairingCode());
  const redeemed = await runEffect(redeemPairingCode({ code: code.code, name }));
  return { id: redeemed.device.id, token: redeemed.token };
};

const authHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const redeemAttempt = (code: string): Promise<Response> =>
  fetch(url(external, "api/devices/pairing-codes/redeem"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

/** Run a body with a test limiter installed, then put the process default back. */
const withLimiter = async (limiter: RedeemLimiter, body: () => Promise<void>): Promise<void> => {
  const saved = runtimeRedeemLimiter();
  setRuntime({ redeemLimiter: limiter });
  try {
    await body();
  } finally {
    setRuntime({ redeemLimiter: saved });
  }
};

/** Attempt a WebSocket upgrade and report whether it opened, or the HTTP status that refused it. */
const upgrade = (port: number, headers: Record<string, string> = {}): Promise<{ status: number; open: boolean }> =>
  new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/socket`, { headers });
    let settled = false;
    const settle = (outcome: { status: number; open: boolean }): void => {
      if (settled) return;
      settled = true;
      socket.terminate();
      resolve(outcome);
    };
    socket.on("open", () => settle({ status: 101, open: true }));
    // A non-101 response arrives here, not as an `error`: this is the 401 the gate wrote.
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      settle({ status: response.statusCode ?? 0, open: false });
    });
    socket.on("error", () => settle({ status: 0, open: false }));
  });

/** Write a config file and refill the snapshot (the device tests' helper, local to this file). */
const writeConfig = async (value: unknown): Promise<void> => {
  await Bun.write(configPath(), JSON.stringify(value));
  reloadConfigSync();
};

test("remoteAccess resolves, validates the port, and defaults to off", async () => {
  await writeConfig({ remoteAccess: { enabled: true, port: 41234 } });
  expect(runtimeConfig().remoteAccess).toEqual({ enabled: true, port: 41234 });

  // A port outside 1..65535 is not a port: the setting falls back to the default rather than
  // emptying the whole config.
  await writeConfig({ remoteAccess: { enabled: true, port: 70000 } });
  expect(runtimeConfig().remoteAccess).toEqual({ enabled: false, port: 4110 });

  await writeConfig({});
  expect(runtimeConfig().remoteAccess).toEqual({ enabled: false, port: 4110 });

  // The settings write path refuses an invalid port rather than persisting it.
  expect(problems({ remoteAccess: { enabled: true, port: 0 } })).toEqual([
    "remoteAccess must name a port between 1 and 65535",
  ]);
});

test("the local listener needs no token", async () => {
  const response = await fetch(url(local, "api/devices"));
  expect(response.status).toBe(200);
});

test("the external listener refuses an api request with no token", async () => {
  const response = await fetch(url(external, "api/devices"));
  expect(response.status).toBe(401);
  // The gateway to a remote workspace injects a token, so it is protected the same way.
  expect((await fetch(url(external, "remote/some/api/x"))).status).toBe(401);
});

test("an unknown or revoked token is refused", async () => {
  const unknown = await fetch(url(external, "api/devices"), { headers: authHeaders("not-a-token") });
  expect(unknown.status).toBe(401);

  const device = await pair("Revoked");
  await runEffect(revokeDevice(device.id));
  const revoked = await fetch(url(external, "api/devices"), { headers: authHeaders(device.token) });
  expect(revoked.status).toBe(401);
});

test("a valid bearer and a valid cookie are accepted", async () => {
  const device = await pair("Bearer and cookie");

  const byBearer = await fetch(url(external, "api/devices"), { headers: authHeaders(device.token) });
  expect(byBearer.status).toBe(200);

  const byCookie = await fetch(url(external, "api/devices"), {
    headers: { cookie: `${DEVICE_COOKIE}=${device.token}` },
  });
  expect(byCookie.status).toBe(200);
});

test("the page is open but its API is not", async () => {
  const page = await fetch(url(external, "/"));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<!doctype html>");

  // A non-API path is not guarded; only `/api/*` is.
  expect((await fetch(url(external, "nowhere"))).status).toBe(404);
});

test("the gate and the router agree on path shapes", async () => {
  // The redeem allowlist tolerates the router's trailing slash: this reaches the route (invalid
  // code), rather than being refused as unauthenticated.
  const trailing = await fetch(url(external, "api/devices/pairing-codes/redeem/"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "0000000000000000" }),
  });
  expect(trailing.status).toBe(400);

  // The allowlist is POST-only.
  expect((await fetch(url(external, "api/devices/pairing-codes/redeem"))).status).toBe(401);

  // The browser pairing endpoint tolerates the trailing slash too, and is POST-only.
  const pairTrailing = await fetch(url(external, "api/devices/pair/"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "0000000000000000" }),
  });
  expect(pairTrailing.status).toBe(400);
  expect((await fetch(url(external, "api/devices/pair"))).status).toBe(401);

  // A trailing slash on a token-required path still requires a token.
  expect((await fetch(url(external, "api/devices/"))).status).toBe(401);
});

test("the redeem bootstrap works without a token and sets the cookie", async () => {
  const code = await runEffect(createPairingCode());
  const response = await fetch(url(external, "api/devices/pairing-codes/redeem"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.code, name: "Remote page" }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { device: { id: string }; token: string };

  const setCookie = response.headers.get("set-cookie") ?? "";
  // A credential-bearing response is never cached.
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(setCookie).toContain(`${DEVICE_COOKIE}=${body.token}`);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");

  // The cookie the browser would carry authenticates the rest of the API.
  const cookie = setCookie.split(";")[0] ?? "";
  const listed = await fetch(url(external, "api/devices"), { headers: { cookie } });
  expect(listed.status).toBe(200);
});

test("the browser pairing endpoint sets the cookie and returns no token", async () => {
  const code = await runEffect(createPairingCode());
  const response = await fetch(url(external, "api/devices/pair"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.code, name: "Remote browser" }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { device: { id: string; name: string }; token?: string };
  expect(body.device.name).toBe("Remote browser");
  // The raw token is never in the body: it is in the HttpOnly cookie and nowhere page JS reads.
  expect(body).not.toHaveProperty("token");

  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(setCookie).toContain(`${DEVICE_COOKIE}=`);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");

  // The cookie the browser carries identifies the new device at the session check.
  const cookie = setCookie.split(";")[0] ?? "";
  const session = await fetch(url(external, "api/devices/session"), { headers: { cookie } });
  expect(session.status).toBe(200);
  const sessionBody = (await session.json()) as {
    authenticated: boolean;
    local: boolean;
    device?: { id: string; name: string };
  };
  expect(sessionBody.authenticated).toBe(true);
  expect(sessionBody.local).toBe(false);
  expect(sessionBody.device?.id).toBe(body.device.id);
  expect(sessionBody.device?.name).toBe("Remote browser");
});

test("the session check reports the local listener and refuses an unauthenticated external one", async () => {
  const localSession = await fetch(url(local, "api/devices/session"));
  expect(localSession.status).toBe(200);
  expect(await localSession.json()).toEqual({ authenticated: true, local: true });

  expect((await fetch(url(external, "api/devices/session"))).status).toBe(401);
});

test("the browser pairing endpoint is rate-limited like redeem", async () => {
  await withLimiter(createRedeemLimiter({ globalLimit: 2, globalWindowMs: 60_000 }), async () => {
    const attempt = (): Promise<Response> =>
      fetch(url(external, "api/devices/pair"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "0000000000000000" }),
      });
    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
  });
});

test("the browser pairing endpoint is refused on the local listener, leaving the code usable", async () => {
  const code = await runEffect(createPairingCode());
  const refused = await fetch(url(local, "api/devices/pair"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.code, name: "Local browser" }),
  });
  expect(refused.status).toBe(400);

  // The code was not consumed, so no dead device record was created: it still redeems.
  const redeemed = await fetch(url(local, "api/devices/pairing-codes/redeem"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.code }),
  });
  expect(redeemed.status).toBe(201);
});

test("a revoked device's cookie is refused at the session check", async () => {
  const code = await runEffect(createPairingCode());
  const paired = await fetch(url(external, "api/devices/pair"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.code, name: "Revoked cookie" }),
  });
  const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const body = (await paired.json()) as { device: { id: string } };
  await runEffect(revokeDevice(body.device.id));
  expect((await fetch(url(external, "api/devices/session"), { headers: { cookie } })).status).toBe(
    401,
  );
});

test("a local-listener redemption sets no cookie", async () => {
  const code = await runEffect(createPairingCode());
  const response = await fetch(url(local, "api/devices/pairing-codes/redeem"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.code, name: "Local" }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("the terminal socket refuses an unauthenticated upgrade and accepts a token", async () => {
  // The no-token upgrade is the front door: a 401 response, not an open socket.
  const refused = await upgrade(external.port);
  expect(refused.open).toBe(false);
  expect(refused.status).toBe(401);

  const device = await pair("Socket");
  expect((await upgrade(external.port, authHeaders(device.token))).open).toBe(true);
  expect((await upgrade(external.port, { cookie: `${DEVICE_COOKIE}=${device.token}` })).open).toBe(true);
});

test("lastSeenAt updates on an authenticated request, throttled", async () => {
  const device = await pair("Seen");
  expect(runtimeConfig().devices.find((d) => d.id === device.id)?.lastSeenAt).toBeUndefined();

  const first = await fetch(url(external, "api/devices"), { headers: authHeaders(device.token) });
  expect(first.status).toBe(200);
  const afterFirst = runtimeConfig().devices.find((d) => d.id === device.id)?.lastSeenAt;
  expect(afterFirst).toBeDefined();

  // A second request inside the throttle window leaves the timestamp where it was.
  await fetch(url(external, "api/devices"), { headers: authHeaders(device.token) });
  expect(runtimeConfig().devices.find((d) => d.id === device.id)?.lastSeenAt).toBe(afterFirst);
});

test("the limiter window rolls over on the injected clock", () => {
  let at = 1_000;
  const limiter = createRedeemLimiter({ globalLimit: 1, globalWindowMs: 1_000, now: () => at });
  expect(limiter.allowAttempt().allowed).toBe(true);
  expect(limiter.allowAttempt().allowed).toBe(false);
  at += 1_000;
  expect(limiter.allowAttempt().allowed).toBe(true);
});

test("the global redeem cap returns 429 with Retry-After", async () => {
  await withLimiter(createRedeemLimiter({ globalLimit: 2, globalWindowMs: 60_000 }), async () => {
    expect((await redeemAttempt("0000000000000000")).status).toBe(400);
    expect((await redeemAttempt("0000000000000000")).status).toBe(400);
    const limited = await redeemAttempt("0000000000000000");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeDefined();
  });
});

test("the per-code failure cap returns 429", async () => {
  await withLimiter(createRedeemLimiter({ globalLimit: 100, codeFailureLimit: 2, globalWindowMs: 60_000 }), async () => {
    expect((await redeemAttempt("FFFFFFFFFFFFFFFF")).status).toBe(400);
    expect((await redeemAttempt("FFFFFFFFFFFFFFFF")).status).toBe(400);
    expect((await redeemAttempt("FFFFFFFFFFFFFFFF")).status).toBe(429);
  });
});

test("the instance record carries the external URL", async () => {
  // The port only names the record file; no listener is started for it.
  const port = 45_999;
  await writeInstanceRecord("http://127.0.0.1:4000/", port, "http://127.0.0.1:4110/");
  try {
    const record = (await instanceRecords()).find((candidate) => candidate.port === port);
    expect(record?.remoteUrl).toBe("http://127.0.0.1:4110/");
  } finally {
    removeInstanceRecord(port);
  }
});

test("a failed external bind leaves the local server serving", async () => {
  const tmp = await testTempDir("remote-bind");
  // Occupy a port so the external listener cannot bind it.
  const blocker = createServer(() => {});
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const address = blocker.address();
  const blockedPort = typeof address === "object" && address !== null ? address.port : 0;

  await mkdir(tmp, { recursive: true });
  await writeFile(
    join(tmp, "config.json"),
    JSON.stringify({ remoteAccess: { enabled: true, port: blockedPort } }),
  );

  const proc = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  try {
    const localUrl = await waitForUrl(proc);
    // The local listener answers though the external bind failed.
    expect((await fetch(`${localUrl}/api/devices`)).status).toBe(200);

    const settings = (await (await fetch(`${localUrl}/api/settings`)).json()) as {
      remoteAccessStatus: { enabled: boolean; listening: boolean; error?: string };
    };
    expect(settings.remoteAccessStatus.enabled).toBe(true);
    expect(settings.remoteAccessStatus.listening).toBe(false);
    expect(settings.remoteAccessStatus.error).toBeDefined();
  } finally {
    proc.kill();
    await proc.exited;
    blocker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
