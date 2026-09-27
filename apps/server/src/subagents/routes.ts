/** The subagent routes: the profile files the Subagents page edits, and the instance operations
 * the CLI, the terminal page and the harness extension drive.
 *
 * Files are the source of truth for profiles, exactly like actions. Instances are the server's
 * own records and messages; the extension relays turns through `next`/`turn`, and the CLI drives
 * create/open/close/send/wait/result. */
import { Effect, Schema } from "effect";

import {
  SubagentCreateRequestSchema,
  SubagentFileRefSchema,
  SubagentFileWriteSchema,
  SubagentSendRequestSchema,
  SubagentTurnRequestSchema,
} from "@corvi/contracts/subagents";
import { BadRequestError } from "@corvi/contracts/errors";
import { bodyAs, guard, json, withChange } from "../capabilities/web.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { deleteSubagentFile, subagentFiles, writeSubagentFile } from "./server/files.ts";
import {
  closeSubagent,
  createSubagent,
  listSubagents,
  nextForSubagent,
  openSubagent,
  recordTurn,
  resultOfSubagent,
  sendToSubagent,
  showSubagent,
  waitForTurn,
  type WaitInput,
} from "./server/instances.ts";

/** The long-poll query: which subagent (`id`), and whether to wait for any or all of them. */
const waitInputOf = (url: string): Effect.Effect<WaitInput, BadRequestError> =>
  Effect.gen(function* () {
    const params = new URL(url).searchParams;
    const id = params.get("id") ?? undefined;
    const sinceRaw = params.get("since");
    const since = sinceRaw === null ? undefined : Number(sinceRaw);
    if (since !== undefined && !Number.isFinite(since)) {
      return yield* new BadRequestError({ message: "since must be a number" });
    }
    const mode = params.get("all") === "1" ? "all" : params.get("any") === "1" ? "any" : "one";
    return { ...(id === undefined ? {} : { id }), ...(since === undefined ? {} : { since }), mode };
  });

export const subagentsRoutes = guard({
  "/api/subagents/files": {
    GET: () => runRoute(Effect.map(subagentFiles(), json)),
    PUT: (req) =>
      runRoute(
        Effect.gen(function* () {
          return json(yield* writeSubagentFile(yield* bodyAs(req, SubagentFileWriteSchema)));
        }),
      ),
    DELETE: (req) =>
      runRoute(
        Effect.gen(function* () {
          const params = Object.fromEntries(new URL(req.url).searchParams);
          const ref = yield* Schema.decodeUnknown(SubagentFileRefSchema)(params).pipe(
            Effect.mapError(() => new BadRequestError({ message: "scope and id are required" })),
          );
          return json(yield* deleteSubagentFile(ref));
        }),
      ),
  },

  "/api/changes/:id/subagents": {
    GET: (req) =>
      withChange(req.params.id, (change) =>
        Effect.map(listSubagents(change), (instances) => json({ instances })),
      ),
    POST: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, SubagentCreateRequestSchema);
          return json(yield* createSubagent(change, body), 201);
        }),
      ),
  },

  // The wait lives before the `:subagent` routes by score (two literal segments more), so a
  // literal `wait` is never read as a subagent id.
  "/api/changes/:id/subagents/wait": {
    GET: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const input = yield* waitInputOf(req.url);
          return json(yield* waitForTurn(change, input));
        }),
      ),
  },

  "/api/changes/:id/subagents/:subagent": {
    GET: (req) => withChange(req.params.id, (change) => Effect.map(showSubagent(change, req.params.subagent), json)),
  },

  "/api/changes/:id/subagents/:subagent/open": {
    POST: (req) =>
      withChange(req.params.id, (change) => Effect.map(openSubagent(change, req.params.subagent), json)),
  },

  "/api/changes/:id/subagents/:subagent/close": {
    POST: (req) =>
      withChange(req.params.id, (change) => Effect.map(closeSubagent(change, req.params.subagent), json)),
  },

  "/api/changes/:id/subagents/:subagent/messages": {
    POST: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, SubagentSendRequestSchema);
          const message = yield* sendToSubagent(
            change,
            req.params.subagent,
            body.text,
            body.from ?? "orchestrator",
          );
          return json(message, 201);
        }),
      ),
  },

  "/api/changes/:id/subagents/:subagent/result": {
    GET: (req) =>
      withChange(req.params.id, (change) =>
        Effect.map(resultOfSubagent(change, req.params.subagent), json),
      ),
  },

  "/api/changes/:id/subagents/:subagent/next": {
    GET: (req) =>
      withChange(req.params.id, (change) => Effect.map(nextForSubagent(change, req.params.subagent), json)),
  },

  "/api/changes/:id/subagents/:subagent/turn": {
    POST: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, SubagentTurnRequestSchema);
          return json(yield* recordTurn(change, req.params.subagent, body.text), 201);
        }),
      ),
  },
});
