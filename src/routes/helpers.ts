import { Effect } from "effect";
import { readChange } from "../changes.ts";
import { NotFoundError } from "../effect/errors.ts";
import { runRoute } from "../effect/run.ts";
import { Workspace } from "../effect/tags.ts";
import type { Change } from "../types.ts";
import { workspaceById, workspaceOf } from "../workspaces.ts";

export const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/** Which context the page is in. Sent by the browser, because that is where the choice lives —
 * two windows open on two clients is a reasonable thing to want. */
export const workspaceParam = (req: Request): string | undefined =>
  new URL(req.url).searchParams.get("workspace") ?? undefined;

/** The request body, or a failure (a body that will not parse is the caller's mistake, which is
 * exactly what the old per-route `await req.json()` inside the try produced). */
export const bodyOf = (req: Request): Effect.Effect<unknown, unknown> =>
  Effect.tryPromise({ try: () => req.json(), catch: (e) => e });

/** A body that is allowed to be absent or broken, read as `{}` — what `.catch(() => ({}))` did. */
export const bodyOrEmpty = (req: Request): Effect.Effect<unknown> =>
  Effect.promise(() => req.json().catch(() => ({})));

/** A sync call that throws typed errors (applyPatch, resolveInRoot) lifted into the error
 * channel at the route boundary — where the old route's try/catch sat. */
export const attempt = <A>(work: () => A): Effect.Effect<A, unknown> =>
  Effect.try({ try: work, catch: (e) => e });

/** Everything this request runs — every `gh`, `az`, `git` and Jira call, however deep — runs as
 * the workspace the change belongs to. The change says which; nothing has to be passed. */
export const withChange = (
  id: string,
  effect: (change: Change) => Effect.Effect<Response, unknown>,
): Promise<Response> =>
  runRoute(
    Effect.flatMap(readChange(id), (change) => {
      if (!change) return Effect.fail(new NotFoundError({ message: `no such change: ${id}` }));
      return Effect.provideService(effect(change), Workspace, workspaceOf(change));
    }),
  );

/** The same, for the requests that are not about a change: the browser says which context it is
 * in, because that is where the choice lives. */
export const withWorkspaceParam = (
  req: Request,
  effect: Effect.Effect<Response, unknown>,
): Promise<Response> =>
  runRoute(Effect.provideService(effect, Workspace, workspaceById(workspaceParam(req))));
