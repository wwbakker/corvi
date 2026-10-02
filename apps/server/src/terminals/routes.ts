import { Effect, Schema } from "effect";
import { TerminalStatusSchema } from "@corvi/contracts/api";
import { changeDir, readChange } from "../change/server/index.ts";
import { BadRequestError } from "@corvi/contracts/errors";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard } from "../capabilities/web.ts";
import {
  allWindows,
  closePane,
  focusPane,
  listWindows,
  moveWindow,
  newWindow,
  selectWindow,
  splitPane,
  terminalSocketPath,
} from "./server/index.ts";
import { openSession, terminalUnavailable, type TerminalSocket, type TerminalSession } from "./server/session.ts";
import { applyStatus } from "./server/status.ts";
import { bodyAs, json, withChange } from "../capabilities/web.ts";

/** A window action: what to do, with the indices and ids the action needs. */
const WindowBody = Schema.Struct({
  action: Schema.String,
  index: Schema.optional(Schema.Number),
  from: Schema.optional(Schema.Number),
  to: Schema.optional(Schema.Number),
  direction: Schema.optional(Schema.Literal("right", "down")),
  window: Schema.optional(Schema.String),
  pane: Schema.optional(Schema.String),
});

/** The change's directory, or undefined when it cannot have a terminal: it does not exist, or
 * it has moved to the archive. The check lives here, where the change is read. */
const terminalDir = (id: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const change = yield* readChange(id);
      return change && !change.completedAt ? changeDir(change) : undefined;
    }),
  );

export const terminalsRoutes = guard({
  // The terminal's socket: one WebSocket per connection, attached to the change's active host
  // session. The session is started before the upgrade, so a failure — the wrong runtime, no
  // host — comes back as an HTTP answer the pane can show rather than a socket that opens and
  // stays silent.
  "/api/changes/:id/terminal/socket": async (req, srv) => {
    const id = decodeURIComponent(req.params.id);
    const dir = await terminalDir(id);
    if (!dir) return new Response("no terminal for this change", { status: 404 });
    const query = new URL(req.url).searchParams;
    // The page fits its terminal before connecting, so this is the size the shell starts at;
    // a missing or malformed pair falls back to the classic 80x24.
    const cols = Number(query.get("cols") ?? 80);
    const rows = Number(query.get("rows") ?? 24);
    // Which pane this socket is for: the page names a session id so it can attach to any pane,
    // not only the window's active one. Absent means the active window's active pane.
    const sessionId = query.get("session") ?? undefined;
    let session: TerminalSession;
    try {
      session = await openSession(id, dir, { cols: cols || 80, rows: rows || 24 }, sessionId);
    } catch (e) {
      // The client reads `{ error }` (apps/web/src/app-root/api.ts); this is the one failure that never
      // becomes a typed taxonomy error, so it is shaped here.
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
    const data: TerminalSocket = { session };
    if (srv.upgrade(req, { data: data as never })) return undefined;
    session.kill(); // the upgrade never happened: nothing else will close the pty
    return new Response("upgrade failed", { status: 400 });
  },

  // Every change's terminals, in one call: the navigation column lists them all, and asking
  // per change would be a read per change every few seconds.
  "/api/terminals": {
    GET: () =>
      runRoute(
        Effect.map(
          Effect.catchAll(allWindows(), () => Effect.succeed({})),
          json,
        ),
      ),
  },

  // The agent status for one host session, reported by the `corvi status` CLI (or a direct POST).
  // Identity is the pty environment's session id and incarnation; a stale incarnation, a dead
  // session or a malformed body is refused rather than stored.
  "/api/terminals/status": {
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = yield* bodyAs(req, TerminalStatusSchema);
          yield* Effect.tryPromise({
            try: () => applyStatus(body),
            catch: (error) => new BadRequestError({ message: error instanceof Error ? error.message : String(error) }),
          });
          return json({ ok: true });
        }),
      ),
  },

  // The change's terminal: where its socket is, and whether the change may have one. The pane
  // asks for this when a terminal is opened; the connection itself is what starts the session.
  "/api/changes/:id/terminal": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          if (c.completedAt) {
            return yield* new BadRequestError({
              message: "this change is completed: its terminal is gone",
            });
          }
          // The reason a terminal cannot start (the wrong runtime) is an answer to this
          // question, so the pane can say it instead of opening a socket that never comes up.
          const unavailable = terminalUnavailable();
          if (unavailable) return json({ error: unavailable }, 500);
          return json({ url: terminalSocketPath(c.id) });
        }),
      ),
  },

  // The windows of the change's registry, and the three things you do to them. The registry is
  // the source of truth for order and labels; a backing that cannot be read is stale data, not a
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
          const body = yield* bodyAs(req, WindowBody);
          const windowId = body.window;
          if (body.action === "new") yield* newWindow(c.id, changeDir(c));
          else if (body.action === "select") yield* selectWindow(c.id, body.index ?? 0);
          else if (body.action === "move") {
            yield* moveWindow(c.id, body.from ?? 0, body.to ?? 0);
          } else if (body.action === "split" && windowId !== undefined) {
            yield* splitPane(c.id, windowId, body.direction ?? "right");
          } else if (body.action === "close-pane" && windowId !== undefined && body.pane !== undefined) {
            yield* closePane(c.id, windowId, body.pane);
          } else if (body.action === "focus-pane" && windowId !== undefined && body.pane !== undefined) {
            yield* focusPane(c.id, windowId, body.pane);
          } else {
            return yield* new BadRequestError({ message: `unknown window action: ${body.action}` });
          }
          return json(yield* listWindows(c.id));
        }),
      ),
  },
});
