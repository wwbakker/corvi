import { Effect, Schema } from "effect";
import { TerminalStatusSchema, type HostStatusDto } from "@corvi/contracts/api";
import { WINDOW_TITLE_MAX } from "@corvi/contracts/terminal";
import { changeDir, currentDirOf, readChange } from "../change/server/index.ts";
import type { Change } from "@corvi/changes/record";
import type { EnvironmentPaneProvider } from "./server/windows.ts";
import { inertWarningLine, NoTerminalWindowError, writeToPane } from "./server/windows.ts";
import { userHarnessProfileLaunch } from "../harnesses/server/index.ts";
import { BadRequestError, InternalError } from "@corvi/contracts/errors";
import { runRoute } from "../capabilities/effect/run.ts";
import { messageOf } from "../capabilities/effect/support.ts";
import { guard } from "../capabilities/web.ts";
import {
  allWindows,
  closePane,
  focusPane,
  listWindows,
  moveWindow,
  newWindow,
  newWindowHere,
  renameWindow,
  selectWindowById,
  splitPane,
  storeAttachment,
  terminalSocketPath,
} from "./server/index.ts";
import {
  openSession,
  terminalUnavailable,
  type TerminalSocket,
  type TerminalSession,
} from "./server/session.ts";
import { applyStatus } from "./server/status.ts";
import { hostStatus } from "./server/hostStatus.ts";
import { restartHostClient } from "./server/host.ts";
import { bodyAs, json, withChange } from "../capabilities/web.ts";

/** A window action: what to do, with the ids and (for a drag) the positions it needs. */
const WindowBody = Schema.Struct({
  action: Schema.String,
  from: Schema.optional(Schema.Number),
  to: Schema.optional(Schema.Number),
  direction: Schema.optional(Schema.Literals(["right", "down"])),
  window: Schema.optional(Schema.String),
  pane: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
  /** A window's new name; an empty string clears it back to the default. */
  title: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(WINDOW_TITLE_MAX)))),
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

/** The host's status and its restart, as effects: a promise's failure becomes the transport's own
 * shape here, so each route is one map. */
const hostStatusEffect = (): Effect.Effect<HostStatusDto, InternalError> =>
  Effect.tryPromise({
    try: () => hostStatus(),
    catch: (error) => new InternalError({ message: messageOf(error) }),
  });

const restartHostEffect = (): Effect.Effect<HostStatusDto, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      await restartHostClient();
      return await hostStatus();
    },
    catch: (error) => new InternalError({ message: messageOf(error) }),
  });

/** A pane's harness is resolved lazily, inside the window registry's lock, and a failure never
 * blocks the plain shell: the pane opens without the environment (today's behavior), logs the
 * error, and is told in the pane before anything else runs. */
const harnessPane = (
  change: Change,
): { readonly provider: EnvironmentPaneProvider; readonly warning: () => string | undefined } => {
  let warning: string | undefined;
  return {
    provider: async () => {
      const result = await Effect.runPromise(userHarnessProfileLaunch(change).pipe(Effect.result));
      if (result._tag === "Success") return { env: result.success.env, harness: result.success.key };
      warning = result.failure.message;
      console.error(warning);
      return { warning };
    },
    warning: () => warning,
  };
};

export const terminalsRoutes = guard({
  // The terminal's socket: one WebSocket per connection, attached to a host session the change
  // already has. The session is resolved before the upgrade, so a failure — the wrong runtime, no
  // host, no window — comes back as an HTTP answer the pane can show rather than a socket that
  // opens and stays silent.
  "/api/changes/:id/terminal/socket": async (req, srv) => {
    const id = decodeURIComponent(req.params.id);
    // A change with no terminal to attach to — unknown, or completed — answers before a socket is
    // started. Which window, if any, is the registry's answer below.
    if (!(await terminalDir(id))) return new Response("no terminal for this change", { status: 404 });
    const query = new URL(req.url).searchParams;
    // The page fits its terminal before connecting, so this is the size the shell was started at;
    // a missing or malformed pair falls back to the classic 80x24.
    const cols = Number(query.get("cols") ?? 80);
    const rows = Number(query.get("rows") ?? 24);
    // Which pane this socket is for: the page names a session id so it can attach to any pane,
    // not only the window's active one. Absent means the active window's active pane.
    const sessionId = query.get("session") ?? undefined;
    let session: TerminalSession;
    try {
      // Attaching never creates a window: one the change does not have is a refusal, which the
      // pane shows like any other failure.
      session = await openSession(id, { cols: cols || 80, rows: rows || 24 }, sessionId);
    } catch (e) {
      // A change that exists with no window is a state, not a fault, and it answers like the
      // missing terminal above. The page asks for a socket URL only when a window exists, so a
      // race — the last window going as the pane mounts — is the one way here.
      if (e instanceof NoTerminalWindowError) return json({ error: e.message }, 404);
      // The client reads `{ error }` (apps/web/src/app-root/api.ts); this is the one failure that never
      // becomes a typed taxonomy error, so it is shaped here.
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
    const data: TerminalSocket = { session };
    // The session is resolved before the handshake, so a malformed one leaves `handleUpgrade`
    // without a callback: `onAbort` (fired when the raw socket closes first) is what kills it.
    const options = { data: data as never, onAbort: () => session.kill() } as never;
    if (srv.upgrade(req, options)) return undefined;
    session.kill(); // the upgrade never happened: nothing else will close the pty
    return new Response("upgrade failed", { status: 400 });
  },

  // Every change's terminals, in one call: the navigation column lists them all, and asking
  // per change would be a read per change every few seconds.
  "/api/terminals": {
    // A failure is a failure, not an empty answer: the browser's window store keeps the last
    // known list and marks the source not fresh, which an empty 200 would hide. The plain
    // `CommandFailure` is classified as a server failure so the message survives the transport.
    GET: () =>
      runRoute(
        Effect.map(
          Effect.mapError(allWindows(), (failure) => new InternalError({ message: failure.message })),
          json,
        ),
      ),
  },

  // The terminal host this server is talking to, and whether it is the one this server would have
  // started. A read-only question: the answer comes from the owner record, and nothing is started
  // or stopped to produce it. The page polls it, so the column can offer a restart instead of the
  // server taking one.
  "/api/terminals/host": {
    GET: () => runRoute(Effect.map(hostStatusEffect(), json)),
  },

  // Replace the host, because the user asked: this ends every pty the old host held, which is why
  // it is a POST with a caller and never a decision the server takes for itself. The answer is the
  // status after the restart, so the page needs no second read.
  "/api/terminals/host/restart": {
    POST: () => runRoute(Effect.map(restartHostEffect(), json)),
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
            catch: (error) =>
              new BadRequestError({ message: error instanceof Error ? error.message : String(error) }),
          });
          return json({ ok: true });
        }),
      ),
  },

  // The change's terminal: where its socket is, and whether the change may have one. The pane asks
  // for this when a window is opened; the connection attaches to that window's session.
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

  // A file dropped or pasted into the change's terminal: the raw bytes, named by `?name=`, stored
  // on this machine — the one the ptys run on, which for a remote workspace is not the page's —
  // and answered with the path the page then pastes. A completed change has no terminal to paste
  // into, so it takes no attachments either.
  "/api/changes/:id/terminal/attachments": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          if (c.completedAt) {
            return yield* new BadRequestError({
              message: "this change is completed: its terminal is gone",
            });
          }
          // Where the change is now, not where a new one would be created: a change that predates
          // a root override stays where it was made, and its files must travel with it.
          const directory = yield* currentDirOf(c.id);
          if (directory === null) {
            return yield* new BadRequestError({ message: "this change's directory is gone" });
          }
          const name = new URL(req.url).searchParams.get("name") ?? "";
          const path = yield* storeAttachment(directory, name, req.body);
          return json({ path });
        }),
      ),
  },

  // The windows of the change's registry, and the three things you do to them. The registry is
  // the source of truth for order and labels; an unreadable backing is reported as a failure so
  // the caller can keep its last known list instead of reading it as an empty change.
  "/api/changes/:id/terminal/windows": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.map(
          Effect.mapError(listWindows(c.id), (failure) => new InternalError({ message: failure.message })),
          json,
        ),
      ),
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, WindowBody);
          const windowId = body.window;
          // "New terminal here": where the active shell is now, or the change's own directory
          // when the change has no window yet.
          if (body.action === "new") {
            const pane = harnessPane(c);
            const created =
              body.directory === undefined || body.directory === "current"
                ? yield* newWindowHere(c.id, changeDir(c), pane.provider)
                : body.directory === "change"
                  ? yield* newWindow(c.id, changeDir(c), pane.provider)
                  : yield* newWindow(c.id, body.directory, pane.provider, changeDir(c));
            const warning = pane.warning();
            if (warning !== undefined) {
              yield* Effect.promise(() => writeToPane(created, warning));
            }
          } else if (body.action === "select") {
            // A window is selected by its id, which is stable across a reorder; a position is not
            // (an activated window leads the row), so there is no index form to send. A window
            // that is gone is reported, not silently ignored.
            if (windowId === undefined) {
              return yield* new BadRequestError({ message: "select needs a window id" });
            }
            yield* selectWindowById(c.id, windowId).pipe(
              Effect.mapError((failure) => new BadRequestError({ message: failure.message })),
            );
          } else if (body.action === "move") {
            yield* moveWindow(c.id, body.from ?? 0, body.to ?? 0);
          } else if (body.action === "rename") {
            if (windowId === undefined) {
              return yield* new BadRequestError({ message: "rename needs a window id" });
            }
            if (body.title === undefined) {
              return yield* new BadRequestError({
                message: "rename needs a title: send one, or an empty string to clear the name",
              });
            }
            yield* renameWindow(c.id, windowId, body.title).pipe(
              Effect.mapError((failure) => new BadRequestError({ message: failure.message })),
            );
          } else if (body.action === "split" && windowId !== undefined) {
            const pane = harnessPane(c);
            const created = yield* splitPane(c.id, windowId, body.direction ?? "right", pane.provider);
            const warning = pane.warning();
            if (warning !== undefined && created !== "") {
              yield* Effect.promise(() => writeToPane(created, warning));
            }
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
