import { test, expect, beforeAll, afterAll } from "bun:test";
import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";

/**
 * The route matching `serve` owns now that Bun's router is gone.
 *
 * Twenty route files depend on the shape this replaced: `:params` handed over raw, one handler
 * per method with a 405 and an `Allow` when the method is the wrong one, most-specific-wins so
 * the page's `/*` fallback never shadows a real route, and streaming bodies in both directions.
 * Bun's router was somebody else's to test; this one is ours, so it is pinned here.
 */
const params = (req: Request): Record<string, string> =>
  (req as Request & { params: Record<string, string> }).params;

let server: Serving;
let url: string;

beforeAll(async () => {
  server = await serve({
    // Port 0: the kernel picks, and serve() reports what it picked.
    port: 0,
    routes: {
      "/static": () => new Response("static"),
      "/one/static": () => new Response("one-static"),
      "/one/:id": {
        GET: (req: Request) => new Response(`get:${params(req).id ?? ""}`),
        POST: () => new Response("posted", { status: 201 }),
      },
      "/one/:id/deep/*": (req: Request) => new Response(`deep:${params(req).id ?? ""}`),
      "/encoded/:name": (req: Request) => new Response(`name:${params(req).name ?? ""}`),
      "/echo": {
        POST: async (req: Request) => new Response(await req.text(), { status: 200 }),
      },
      "/*": () => new Response("fallback"),
    },
  });
  url = server.url.toString();
});

afterAll(() => server?.stop());

test("the most specific route wins, and the fallback is the last resort", async () => {
  expect(await (await fetch(`${url}static`)).text()).toBe("static");
  // `one/static` (two literal segments) beats `one/:id` (one).
  expect(await (await fetch(`${url}one/static`)).text()).toBe("one-static");
  expect(await (await fetch(`${url}one/abc`)).text()).toBe("get:abc");
  expect(await (await fetch(`${url}nowhere`)).text()).toBe("fallback");
});

test("a method map answers 405 with what was allowed", async () => {
  const response = await fetch(`${url}one/abc`, { method: "DELETE" });
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET, POST");
  expect((await fetch(`${url}one/abc`, { method: "POST" })).status).toBe(201);
});

test("parameters arrive raw, exactly as Bun handed them over", async () => {
  // Not decoded: the terminal route does its own decodeURIComponent, and the file routes pass
  // theirs through basename().
  expect(await (await fetch(`${url}encoded/a%20b`)).text()).toBe("name:a%20b");
});

test("a wildcard matches the rest of the path, and a trailing slash is the same path", async () => {
  expect(await (await fetch(`${url}one/abc/deep/x/y`)).text()).toBe("deep:abc");
  expect(await (await fetch(`${url}one/abc/`)).text()).toBe("get:abc");
});

test("request bodies stream through", async () => {
  const response = await fetch(`${url}echo`, { method: "POST", body: "hello body" });
  expect(await response.text()).toBe("hello body");
});
