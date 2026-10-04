import { expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { BadRequestError } from "@corvi/contracts/errors";
import {
  pairRemoteWorkspace,
  type PairedRemote,
} from "../apps/server/src/workspace/server/index.ts";
import { workspaceRoutes } from "../apps/server/src/workspace/routes.ts";

/**
 * The pairing helper, against a scripted stand-in for another Corvi server. The helper is the
 * local server redeeming a code on a remote; every way that can go wrong has to come back as one
 * typed `BadRequestError` the settings editor can show, never as an unhandled throw.
 */

/** A stand-in remote: `Bun.serve` on an ephemeral port, scripted per test. */
const serveRemote = (
  handler: (req: Request) => Response | Promise<Response>,
): { url: string; stop: () => void } => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
};

/** A remote that accepts the connection and then never answers. */
const hungRemote = (): { url: string; stop: () => void } => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Promise<Response>(() => {}),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
};

const pair = (input: {
  url: string;
  code: string;
  name?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Either.Either<PairedRemote, BadRequestError>> =>
  Effect.runPromise(Effect.either(pairRemoteWorkspace(input)));

test("pairing redeems the code and offers the remote's workspaces", async () => {
  const seen: string[] = [];
  const remote = serveRemote(async (req) => {
    const url = new URL(req.url);
    seen.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/api/devices/pairing-codes/redeem") {
      expect(await req.json()).toEqual({ code: "abcd", name: "laptop" });
      return Response.json(
        { device: { id: "dev-1", name: "laptop", createdAt: "2026-01-01T00:00:00.000Z" }, token: "raw-token" },
        { status: 201 },
      );
    }
    if (url.pathname === "/api/workspaces") {
      // The token from the redemption is presented to read the remote's workspaces.
      expect(req.headers.get("authorization")).toBe("Bearer raw-token");
      return Response.json({
        workspaces: [
          { id: "client", name: "Client" },
          { id: "personal", name: "Personal" },
        ],
        platform: "linux",
      });
    }
    return new Response("no such route", { status: 404 });
  });

  const result = await pair({ url: remote.url, code: "abcd", name: "laptop" });
  expect(result._tag).toBe("Right");
  if (result._tag === "Right") {
    expect(result.right.token).toBe("raw-token");
    expect(result.right.device.id).toBe("dev-1");
    // Only ids and names come back: the editor is choosing a target, not reading the remote.
    expect(result.right.workspaces).toEqual([
      { id: "client", name: "Client" },
      { id: "personal", name: "Personal" },
    ]);
  }
  expect(seen).toEqual(["POST /api/devices/pairing-codes/redeem", "GET /api/workspaces"]);
  remote.stop();
});

test("a code the remote refuses is a BadRequest carrying its reason", async () => {
  const remote = serveRemote(() =>
    Response.json({ error: "that pairing code has expired" }, { status: 400 }),
  );
  const result = await pair({ url: remote.url, code: "wrong" });
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toBeInstanceOf(BadRequestError);
    expect(result.left.message).toContain("that pairing code has expired");
  }
  remote.stop();
});

test("a url that is not http(s) is refused before any request", async () => {
  const result = await pair({ url: "ftp://host.example/x", code: "abcd" });
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toBeInstanceOf(BadRequestError);
    expect(result.left.message).toContain("http");
  }
});

test("a server that is not Corvi is a BadRequest, not a throw", async () => {
  const remote = serveRemote(
    () =>
      new Response("<html>hello</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  );
  const result = await pair({ url: remote.url, code: "abcd" });
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left).toBeInstanceOf(BadRequestError);
  remote.stop();
});

test("an unreachable server is a BadRequest", async () => {
  // Nothing is listening on this port: bind one, learn it, then close it.
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const dead = `http://127.0.0.1:${probe.port}`;
  void probe.stop(true);
  const result = await pair({ url: dead, code: "abcd" });
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left).toBeInstanceOf(BadRequestError);
});

test("a redirect is refused, not followed", async () => {
  let followed = false;
  const destination = serveRemote(() => {
    followed = true;
    return Response.json({
      device: { id: "dev-1", name: "laptop", createdAt: "2026-01-01T00:00:00.000Z" },
      token: "leaked",
    });
  });
  const remote = serveRemote(() => Response.redirect(destination.url, 302));
  const result = await pair({ url: remote.url, code: "abcd" });
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toBeInstanceOf(BadRequestError);
    expect(result.left.message).toContain("redirect");
  }
  // The freshly minted token must never have reached the redirect target.
  expect(followed).toBe(false);
  remote.stop();
  destination.stop();
});

test("a hung remote is abandoned after the timeout", async () => {
  const remote = hungRemote();
  const started = Date.now();
  const result = await pair({ url: remote.url, code: "abcd", timeoutMs: 150 });
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toBeInstanceOf(BadRequestError);
    expect(result.left.message).toContain("did not answer");
  }
  expect(Date.now() - started).toBeLessThan(5_000);
  remote.stop();
});

test("aborting the request cancels a hung remote", async () => {
  const remote = hungRemote();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const result = await pair({ url: remote.url, code: "abcd", signal: controller.signal });
  expect(result._tag).toBe("Left");
  expect(Date.now() - started).toBeLessThan(5_000);
  remote.stop();
});

/** The route as the page reaches it, through the same guard the server composes. */
const postPairRemote = async (body: unknown): Promise<Response> => {
  const routes = workspaceRoutes as unknown as Record<
    string,
    { POST: (req: Request) => Promise<Response> }
  >;
  return routes["/api/workspaces/pair-remote"]!.POST!(
    new Request("http://127.0.0.1:4000/api/workspaces/pair-remote", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
    }),
  );
};

test("the pair-remote route marks its token-bearing answer no-store", async () => {
  const remote = serveRemote((req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/api/devices/pairing-codes/redeem")) {
      return Response.json(
        { device: { id: "dev-1", name: "laptop", createdAt: "2026-01-01T00:00:00.000Z" }, token: "raw-token" },
        { status: 201 },
      );
    }
    return Response.json({ workspaces: [], platform: "linux" });
  });
  const response = await postPairRemote({ url: remote.url, code: "abcd" });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()) as { token: string }).toMatchObject({ token: "raw-token" });
  remote.stop();
});
