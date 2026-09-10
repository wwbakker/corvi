import { Effect } from "effect";
import { readChange } from "../changes.ts";
import { BadRequestError } from "../effect/errors.ts";
import { runRoute } from "../effect/run.ts";
import { guard } from "../origin.ts";
import {
  allWindows,
  listWindows,
  moveWindow,
  newWindow,
  selectWindow,
  terminalGone,
  terminalPath,
  terminalPort,
} from "../terminal.ts";
import { proxyToTtyd, type Bridge } from "../terminalProxy.ts";
import { bodyOf, json, withChange } from "./helpers.ts";

/** ttyd's page and its socket, served from here: see src/terminalProxy.ts for why. */
const portForChange = (id: string): Promise<number | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const change = yield* readChange(id);
      return change && !change.completedAt ? yield* terminalPort(change) : undefined;
    }),
  );

export const terminalsRoutes = guard({
  // ttyd, served from here so the page and the terminal share an origin. Both the page and
  // its WebSocket come through this one route.
  "/terminal/:id/*": async (req, srv) => {
    const id = decodeURIComponent(req.params.id);
    const port = await portForChange(id);
    if (!port) return new Response("no terminal for this change", { status: 404 });
    if (req.headers.get("upgrade") === "websocket") {
      const data: Bridge = { queue: [], port };
      return srv.upgrade(req, { data: data as never })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    const rest = new URL(req.url).pathname.slice(`/terminal/${req.params.id}/`.length);
    return proxyToTtyd(req, port, rest);
  },

  // Every change's terminals, in one call: the navigation column lists them all, and asking
  // per change would be a process per change every few seconds. A timed-out tmux is no news,
  // not a failed request.
  "/api/terminals": {
    GET: () =>
      runRoute(
        Effect.map(
          Effect.catchAll(allWindows(), () => Effect.succeed({})),
          json,
        ),
      ),
  },

  // The change's terminal: a tmux session in the change directory, served by ttyd. Starting
  // it is what asking for the URL does.
  "/api/changes/:id/terminal": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          yield* terminalPort(c); // starts or adopts it, so the frame has something to load
          // And whether what it starts or adopts still has a session behind it: a ttyd whose
          // tmux server is gone is a dead frame, and the page should say so.
          const state = yield* terminalGone(c.id);
          return json({ url: terminalPath(c.id), ...state });
        }),
      ),
  },

  // The windows of the change's tmux session, and the two things you do to them. tmux is the
  // source of truth: this only reads and pokes it. A timed-out tmux is an empty strip, not a
  // failed request.
  "/api/changes/:id/terminal/windows": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.map(
          Effect.catchAll(listWindows(c.id), () => Effect.succeed([])),
          json,
        ),
      ),
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as {
            action: "new" | "select" | "move";
            index?: number;
            from?: number;
            to?: number;
          };
          if (body.action === "new") yield* newWindow(c.id);
          else if (body.action === "select") yield* selectWindow(c.id, body.index ?? 0);
          else if (body.action === "move") {
            yield* moveWindow(c.id, body.from ?? 0, body.to ?? 0);
          } else {
            return yield* Effect.fail(
              new BadRequestError({ message: `unknown window action: ${body.action}` }),
            );
          }
          return json(yield* listWindows(c.id));
        }),
      ),
  },
});
