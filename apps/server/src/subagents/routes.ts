/** The subagent routes: the profile files the Subagents page edits, and the instance operations
 * the CLI and the harness extension drive.
 *
 * Files are the source of truth for profiles, exactly like actions. Instances are the server's
 * own records and messages; the extension relays turns through `next`/`turn`, and the CLI drives
 * create/open/close/send/await/result. */
import { Effect, Schema } from "effect";

import {
  SubagentCreateRequestSchema,
  SubagentFileRefSchema,
  SubagentFileWriteSchema,
  SubagentRepositoryFileRefSchema,
  SubagentRepositoryFileWriteSchema,
  SubagentSendRequestSchema,
  SubagentTurnRequestSchema,
} from "@corvi/contracts/subagents";
import { BadRequestError } from "@corvi/contracts/errors";
import { bodyAs, guard, json, withChange } from "../capabilities/web.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { deleteSubagentFile, deleteRepositorySubagentFile, repositorySubagentFiles, subagentFiles, writeSubagentFile, writeRepositorySubagentFile } from "./server/files.ts";
import { profilesFor } from "./server/run.ts";
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
  awaitReady,
  type AwaitInput,
} from "./server/instances.ts";

/** The long-poll query: which subagents (`id`, repeated — empty means every subagent of the
 * change), whether to await any or all of them, and an explicit `turn` target. Pure: the turn is a
 * plain positive message number or missing, so `0x10`/`1e3` become a bad request in `awaitReady`
 * rather than a silently converted turn. */
const awaitInputOf = (url: string): AwaitInput => {
  const params = new URL(url).searchParams;
  const ids = params.getAll("id").filter((one) => one !== "");
  const mode = params.get("all") === "1" ? "all" : "any";
  const turnRaw = params.get("turn");
  const turn = turnRaw === null ? undefined : /^\d+$/.test(turnRaw) ? Number(turnRaw) : Number.NaN;
  return { ids, mode, ...(turn === undefined ? {} : { turn }) };
};

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
          const ref = yield* Schema.decodeUnknownEffect(SubagentFileRefSchema)(params).pipe(
            Effect.mapError(() => new BadRequestError({ message: "scope and id are required" })),
          );
          return json(yield* deleteSubagentFile(ref));
        }),
      ),
  },

  "/api/changes/:id/subagent-profiles": {
    GET: (req) =>
      withChange(req.params.id, (change) => Effect.map(profilesFor(change), json)),
  },

  // The Repositories view's files: one block per checkout, written and deleted like any other
  // scope — the route names the change, the body (or query) names the repository.
  "/api/changes/:id/subagent-files": {
    GET: (req) =>
      withChange(req.params.id, (change) => Effect.map(repositorySubagentFiles(change), json)),
    PUT: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, SubagentRepositoryFileWriteSchema);
          return json(yield* writeRepositorySubagentFile(change, body));
        }),
      ),
    DELETE: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const params = Object.fromEntries(new URL(req.url).searchParams);
          const ref = yield* Schema.decodeUnknownEffect(SubagentRepositoryFileRefSchema)(params).pipe(
            Effect.mapError(() => new BadRequestError({ message: "repository and id are required" })),
          );
          return json(yield* deleteRepositorySubagentFile(change, ref));
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
          const key = req.headers.get("idempotency-key") ?? undefined;
          return json(yield* createSubagent(change, body, undefined, key), 201);
        }),
      ),
  },

  // The await lives before the `:subagent` routes by score (two literal segments more), so a
  // literal `await` is never read as a subagent id.
  "/api/changes/:id/subagents/await": {
    GET: (req) =>
      withChange(req.params.id, (change) => Effect.map(awaitReady(change, awaitInputOf(req.url)), json)),
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
          const key = req.headers.get("idempotency-key") ?? undefined;
          const message = yield* sendToSubagent(
            change,
            req.params.subagent,
            body.text,
            body.from ?? "orchestrator",
            key,
          );
          return json(message, 201);
        }),
      ),
  },

  "/api/changes/:id/subagents/:subagent/result": {
    GET: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const turnRaw = new URL(req.url).searchParams.get("turn");
          // A plain positive message number or nothing; `0x10` is not a turn.
          if (turnRaw !== null && !/^\d+$/.test(turnRaw)) {
            return yield* new BadRequestError({ message: "turn needs a positive message number" });
          }
          const turn = turnRaw === null ? undefined : Number(turnRaw);
          if (turn !== undefined && turn < 1) {
            return yield* new BadRequestError({ message: "turn needs a positive message number" });
          }
          return json(yield* resultOfSubagent(change, req.params.subagent, turn));
        }),
      ),
  },

  "/api/changes/:id/subagents/:subagent/next": {
    GET: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const afterRaw = new URL(req.url).searchParams.get("after");
          const after = afterRaw === null ? undefined : Number(afterRaw);
          return json(yield* nextForSubagent(change, req.params.subagent, Number.isFinite(after) ? after : undefined));
        }),
      ),
  },

  "/api/changes/:id/subagents/:subagent/turn": {
    POST: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, SubagentTurnRequestSchema);
          const key = req.headers.get("idempotency-key") ?? undefined;
          return json(
            yield* recordTurn(change, req.params.subagent, {
              text: body.text,
              ...(key === undefined ? {} : { key }),
              ...(body.pane === undefined ? {} : { pane: body.pane }),
              ...(body.inReplyTo === undefined ? {} : { inReplyTo: body.inReplyTo }),
            }),
            201,
          );
        }),
      ),
  },
});
