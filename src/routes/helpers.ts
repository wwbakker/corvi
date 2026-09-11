import { Effect } from "effect";
import { readChange } from "../changes.ts";
import { BadRequestError, isIweError, NotFoundError, type IweError } from "../effect/errors.ts";
import { messageOf } from "../effect/support.ts";
import { runRoute } from "../effect/run.ts";
import { Workspace } from "../effect/tags.ts";
import type { Change } from "../types.ts";
import { workspaceById, workspaceOf } from "../workspaces.ts";

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

/** A sync call that throws typed errors (applyPatch, resolveInRoot) lifted into the error
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
