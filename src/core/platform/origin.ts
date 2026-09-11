import type { Serve } from "bun";
import type { Bridge } from "../../terminal/server/proxy.ts";

/**
 * Whether this request came from our own page.
 *
 * The server listens on the loopback address, which keeps other machines out but not other
 * programs on this one — and the program that matters is your browser. Any website you have open
 * can POST to `http://127.0.0.1:4000/api/...`; it cannot read the answer, because we send no CORS
 * headers, but it does not need to read anything to create a change or delete a leftover.
 *
 * Browsers say where a request came from and have done for years: `Sec-Fetch-Site` on everything,
 * `Origin` on anything that is not a plain navigation. `none` is you — a typed URL, a bookmark,
 * the app opening its window.
 */
export function sameSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  // curl and the tests send neither header, and neither is a browser: nothing can be tricked
  // into making that request on your behalf.
  return !origin || new URL(origin).host === new URL(req.url).host;
}

/**
 * The same routes, refusing anything another site asked for. Wrapped in one place rather than
 * checked in each handler: a check you have to remember in forty places is a check that is
 * missing from one of them.
 *
 * Typed with Bun's own route shape, so every handler still knows its own path parameters —
 * passing the routes through a plainer type would take `req.params` with it.
 */
export function guard<R extends string>(
  routes: Serve.RoutesWithUpgrade<Bridge, R>,
): Serve.RoutesWithUpgrade<Bridge, R> {
  const forbidden = (): Response => new Response("not for another site", { status: 403 });
  const wrap =
    (handler: (req: never, srv: never) => unknown) =>
    (req: never, srv: never): unknown =>
      sameSite(req as Request) ? handler(req, srv) : forbidden();

  // Named rather than inferred: the bundled page is an object with no enumerable properties of
  // its own, and "every property is a function" is vacuously true of it. Wrapping it turned the
  // whole app into an empty object, which Bun rejected at startup — the good case.
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  const isMethodMap = (value: object): boolean =>
    Object.keys(value).length > 0 && Object.keys(value).every((key) => METHODS.includes(key));

  const guarded: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes as Record<string, unknown>)) {
    if (typeof value === "function") {
      guarded[path] = wrap(value as (req: never, srv: never) => unknown);
    } else if (value && typeof value === "object" && isMethodMap(value)) {
      // One entry per method: { GET, POST }.
      guarded[path] = Object.fromEntries(
        Object.entries(value as Record<string, (req: never, srv: never) => unknown>).map(
          ([method, fn]) => [method, wrap(fn)],
        ),
      );
    } else {
      // The bundled page itself, which is not a handler at all.
      guarded[path] = value;
    }
  }
  return guarded as Serve.RoutesWithUpgrade<Bridge, R>;
}
