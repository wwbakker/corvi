import { Effect, Schema } from "effect";
import { changeDir, readChange } from "../change/server/index.ts";
import { ideationPromptFor } from "../change/server/index.ts";
import { BadRequestError } from "../capabilities/effect/errors.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard } from "../capabilities/web.ts";
import {
  allWindows,
  ensureSession,
  listWindows,
  moveWindow,
  newWindow,
  pastePrompt,
  selectWindow,
  terminalSocketPath,
} from "./server/index.ts";
import { openSession, terminalUnavailable, type TerminalSocket, type TerminalSession } from "./server/session.ts";
import { bodyAs, json, withChange } from "../capabilities/web.ts";

/** A window action: what to do, with the indices the action needs. */
const WindowBody = Schema.Struct({
  action: Schema.String,
  index: Schema.optional(Schema.Number),
  from: Schema.optional(Schema.Number),
  to: Schema.optional(Schema.Number),
});

/** The change's directory, or undefined when it cannot have a terminal: it does not exist, or
 * it has moved to the archive. The check lives here, where the change is read. */
const terminalDir = (id: string): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const change = yield* readChange(id);
      return change && !change.completedAt ? changeDir(change.id) : undefined;
    }),
  );

export const terminalsRoutes = guard({
  // The terminal's socket: one pty per connection, attached to the change's tmux session. The
  // session is started before the upgrade, so a failure — a missing tmux, a Bun server, which
  // never delivers pty output — comes back as an HTTP answer the pane can show rather than a
  // socket that opens and stays silent.
  "/api/changes/:id/terminal/socket": async (req, srv) => {
    const id = decodeURIComponent(req.params.id);
    const dir = await terminalDir(id);
    if (!dir) return new Response("no terminal for this change", { status: 404 });
    const query = new URL(req.url).searchParams;
    // The page fits its terminal before connecting, so this is the size the shell starts at;
    // a missing or malformed pair falls back to the classic 80x24.
    const cols = Number(query.get("cols") ?? 80);
    const rows = Number(query.get("rows") ?? 24);
    let session: TerminalSession;
    try {
      session = openSession(id, dir, { cols: cols || 80, rows: rows || 24 });
    } catch (e) {
      // The client reads `{ error }` (src/app-root/api.ts); this is the one failure that never
      // becomes a typed taxonomy error, so it is shaped here.
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
    const data: TerminalSocket = { session };
    if (srv.upgrade(req, { data: data as never })) return undefined;
    session.kill(); // the upgrade never happened: nothing else will close the pty
    return new Response("upgrade failed", { status: 400 });
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
          // The reason a terminal cannot start (the wrong runtime, no tmux) is an answer to
          // this question, so the pane can say it instead of opening a socket that never comes
          // up.
          const unavailable = terminalUnavailable();
          if (unavailable) return json({ error: unavailable }, 500);
          return json({ url: terminalSocketPath(c.id) });
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
          const body = yield* bodyAs(req, WindowBody);
          if (body.action === "new") yield* newWindow(c.id, changeDir(c.id));
          else if (body.action === "select") yield* selectWindow(c.id, body.index ?? 0);
          else if (body.action === "move") {
            yield* moveWindow(c.id, body.from ?? 0, body.to ?? 0);
          } else {
            return yield* new BadRequestError({ message: `unknown window action: ${body.action}` });
          }
          return json(yield* listWindows(c.id));
        }),
      ),
  },

  // Brief an agent about an idea: paste the configured prompt into the change's terminal, which
  // is where the conversation happens. The session is created if it is not up yet, so this works
  // from the dashboard without opening the terminal first. The text is not submitted — see
  // pastePrompt for why that keystroke is the user's.
  "/api/changes/:id/terminal/prompt": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          if (c.completedAt) {
            return yield* new BadRequestError({
              message: "this change is completed: its terminal is gone",
            });
          }
          yield* ensureSession(c.id, changeDir(c.id));
          yield* pastePrompt(c.id, ideationPromptFor(c));
          return json({ pasted: true });
        }),
      ),
  },
});
