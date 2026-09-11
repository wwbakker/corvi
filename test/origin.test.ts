import { test, expect } from "bun:test";
import { guard, sameSite } from "../src/origin.ts";

/**
 * The server listens on the loopback address, which keeps other machines out but not the browser
 * you already have open. A page on any website can post to it, and while it cannot read the
 * answer, it does not need to read anything to create a change or delete a leftover.
 */
const asked = (headers: Record<string, string>, url = "http://127.0.0.1:4000/api/changes"): boolean =>
  sameSite(new Request(url, { headers }));

test("who is allowed to ask", () => {
  // Our own page, in every way a browser describes it.
  expect(asked({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4000" })).toBe(true);
  // A typed URL, a bookmark, the app opening its window: no site asked for this at all.
  expect(asked({ "sec-fetch-site": "none" })).toBe(true);
  // curl and the tests. Nothing can be tricked into making one of these on your behalf.
  expect(asked({})).toBe(true);

  expect(asked({ "sec-fetch-site": "cross-site", origin: "https://example.com" })).toBe(false);
  // A form post carries no Origin in some browsers, but still says where it came from.
  expect(asked({ "sec-fetch-site": "cross-site" })).toBe(false);
  // An Origin that is another host, with no Sec-Fetch-Site to give it away.
  expect(asked({ origin: "https://example.com" })).toBe(false);
  // Same scheme and port, different host: localhost and 127.0.0.1 are not the same origin.
  expect(asked({ origin: "http://localhost:4000" })).toBe(false);
});

test("every route is wrapped, and what is not a route is left alone", async () => {
  // Bun's route table holds handlers, tables of handlers by method, and the bundled page — which
  // is an object with no enumerable properties, so "all of its properties are functions" is
  // vacuously true of it. Wrapping that turned the whole app into an empty object.
  const page = Object.create({ index: "app.html" }) as never;
  const routes = guard({
    "/api/one": () => new Response("one"),
    "/api/two": { GET: () => new Response("get"), POST: () => new Response("post") },
    "/*": page,
  } as never) as unknown as Record<string, never>;

  const mine = new Request("http://127.0.0.1:4000/api/one", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  const theirs = new Request("http://127.0.0.1:4000/api/one", {
    headers: { "sec-fetch-site": "cross-site" },
  });

  const one = routes["/api/one"] as unknown as (req: Request) => Response;
  expect((await one(mine)).status).toBe(200);
  expect((await one(theirs)).status).toBe(403);

  const two = routes["/api/two"] as unknown as Record<string, (req: Request) => Response>;
  expect((await two.POST!(theirs)).status).toBe(403);
  expect(await (await two.GET!(mine)).text()).toBe("get");

  // The page itself is passed through as it was, not turned into a handler.
  expect(routes["/*"]).toBe(page);
});
