import type { Serve } from "bun";
import type { TerminalSocket } from "../terminals/server/session.ts";
import { Effect } from "effect";
import { readChange } from "../change/server/index.ts";
import { BadRequestError, isIweError, NotFoundError, type IweError } from "./effect/errors.ts";
import { messageOf } from "./effect/support.ts";
import { runRoute } from "./effect/run.ts";
import { Workspace } from "./effect/tags.ts";
import { ChangesLive } from "../extension-host/services.ts";
import { Changes } from "../extension-host/api.ts";
import type { Change } from "../domain/change.ts";
import { workspaceById, workspaceOf } from "../workspace/server/index.ts";

// --- Origin guard -------------------------------------------------------------

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
  routes: Serve.RoutesWithUpgrade<TerminalSocket, R>,
): Serve.RoutesWithUpgrade<TerminalSocket, R> {
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
  return guarded as Serve.RoutesWithUpgrade<TerminalSocket, R>;
}

// --- Request helpers ----------------------------------------------------------

export const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/** Which context the page is in. Sent by the browser, because that is where the choice lives —
 * two windows open on two clients is a reasonable thing to want. */
export const workspaceParam = (req: Request): string | undefined =>
  new URL(req.url).searchParams.get("workspace") ?? undefined;

/** The request body, or a failure (a body that will not parse is the caller's mistake). */
export const bodyOf = (req: Request): Effect.Effect<unknown, BadRequestError> =>
  Effect.tryPromise({
    try: () => req.json(),
    catch: (e) => new BadRequestError({ message: e instanceof Error ? e.message : String(e) }),
  });

/** A body that is allowed to be absent or broken, read as `{}` — what `.catch(() => ({}))` did. */
export const bodyOrEmpty = (req: Request): Effect.Effect<unknown> =>
  Effect.promise(() => req.json().catch(() => ({})));

/** A sync call that throws typed errors (applyPatch, resolveDirectory) lifted into the error
 * channel at the route boundary. Anything that is not one of ours is reported like one, which is
 * the same message-and-400 `runRoute` would give an escaped throw. */
export const attempt = <A>(work: () => A): Effect.Effect<A, IweError> =>
  Effect.try({
    try: work,
    catch: (e) => (isIweError(e) ? e : new BadRequestError({ message: messageOf(e) })),
  });

/** Everything this request runs — every `gh`, `az`, `git` and Jira call, however deep — runs as
 * the workspace the change belongs to. The change says which; nothing has to be passed. */
export const withChange = (
  id: string,
  effect: (change: Change) => Effect.Effect<Response, unknown, Changes>,
): Promise<Response> => runRoute(withChangeEffect(id, effect));

/** `withChange`'s effect, kept apart from running it: a test provides its own Shell layer and
 * runs it through the same error mapping (`runRoute`), so a route is exercised with a scripted
 * CLI instead of the real one. */
export const withChangeEffect = (
  id: string,
  effect: (change: Change) => Effect.Effect<Response, unknown, Changes>,
): Effect.Effect<Response, unknown> =>
  Effect.flatMap(readChange(id), (change) => {
    if (!change) return Effect.fail(new NotFoundError({ message: `no such change: ${id}` }));
    return Effect.provideService(effect(change), Workspace, workspaceOf(change));
  }).pipe(Effect.provide(ChangesLive));

/** The same, for the requests that are not about a change: the browser says which context it is
 * in, because that is where the choice lives. */
export const withWorkspaceParam = (
  req: Request,
  effect: Effect.Effect<Response, unknown>,
): Promise<Response> =>
  runRoute(Effect.provideService(effect, Workspace, workspaceById(workspaceParam(req))));
