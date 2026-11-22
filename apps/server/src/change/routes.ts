import { Effect, Schema } from "effect";
import {
  applyPatch,
  cancelChange,
  changeDir,
  completeChange,
  completionOf,
  createChange,
  currentDirOf,
  listChanges,
  PLAN_FILE,
  prDescription,
  progressOf,
  readChange,
  readSidecar,
  refreshTitles,
  reopenChange,
  writeChangeAt,
  writeSidecar,
} from "../change/server/index.ts";
import { ChangeId } from "@corvi/contracts/changes";
import {
  ChangeStateSchema,
  CreateChangeBodySchema,
  ForceBodySchema,
  PlanWriteBodySchema,
  ReposBodySchema,
} from "@corvi/contracts/api";
import { runRoute } from "../capabilities/effect/run.ts";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  isCorviError,
  type CorviError,
} from "@corvi/contracts/errors";
import { AbsolutePath } from "@corvi/contracts/paths";
import { AgentTranscripts, TRANSCRIPTS_DIRECTORY } from "@corvi/agents/transcripts";
import { agentTranscriptsLayer } from "./lifecycle-layer.ts";
import { ChangeConflict, ChangeFormatTooNew } from "@corvi/changes/errors";
import { ChangeAlreadyExists, InvalidChangeDraft, InvalidChangeEdit } from "./errors.ts";
import { messageOf } from "../capabilities/effect/support.ts";
import { textRevision } from "../capabilities/files.ts";
import { isFinished } from "@corvi/changes/record";
import type { Change } from "@corvi/changes/record";
import type { Changes } from "../integrations/api/capabilities.ts";
import { announce } from "../capabilities/bus.ts";
import { repoStates } from "../vendors/git.ts";
import { guard } from "../capabilities/web.ts";
import { workspaceOf } from "../workspace/server/index.ts";
import { bodyAs, json, withChange } from "../capabilities/web.ts";
import { provisionRepositories, setRepos } from "./provisioning.ts";
import { assignTicketOnCreate, finishTicket, startTicket } from "./tickets.ts";

// The request bodies, decoded at the boundary: the schema is the contract, and a body that does
// not fit is the caller's 400 naming the field rather than a cast the compiler cannot check. The
// create and force bodies are the canonical contract schemas (shared with the browser client).

/** The one place a change-domain refusal becomes an HTTP status: an id already taken and an edit
 * against where the change stands are conflicts; a draft the core refuses is the caller's 400;
 * a record from a newer Corvi is a conflict with the version that can edit it. */
const changeError = (error: unknown): CorviError => {
  if (error instanceof ChangeAlreadyExists) return new ConflictError({ message: error.message });
  if (error instanceof ChangeFormatTooNew) return new ConflictError({ message: error.message });
  if (error instanceof ChangeConflict) return new ConflictError({ message: error.message });
  if (error instanceof InvalidChangeDraft) return new BadRequestError({ message: error.message });
  if (error instanceof InvalidChangeEdit) {
    return error.conflict
      ? new ConflictError({ message: error.message })
      : new BadRequestError({ message: error.message });
  }
  return isCorviError(error) ? error : new BadRequestError({ message: messageOf(error) });
};

/** A transcript that is not there is the caller's 404; one that cannot be read is ours. */
const transcriptError = (error: { readonly _tag: string; readonly message: string }): CorviError =>
  error._tag === "TranscriptNotFound"
    ? new NotFoundError({ message: error.message })
    : new InternalError({ message: error.message });

/** The change's copies, wherever the change is now. */
const transcriptsDirOf = (id: string): Effect.Effect<AbsolutePath, NotFoundError> =>
  Effect.flatMap(currentDirOf(id), (dir) =>
    dir
      ? Effect.succeed(AbsolutePath.make(`${dir}/${TRANSCRIPTS_DIRECTORY}`))
      : Effect.fail(new NotFoundError({ message: `no such change: ${id}` })),
  );

const PatchBody = Schema.Struct({
  // The wire shape of the phase, not a free string: an unknown word — an empty one included — is
  // the caller's 400 at the boundary, before any write, stamp or ticket move.
  state: Schema.optional(ChangeStateSchema),
  title: Schema.optional(Schema.String),
  // The harness selectors: absent leaves the choice alone, null is "Default" (store nothing).
  userHarness: Schema.optional(Schema.NullOr(Schema.String)),
  subagentHarness: Schema.optional(Schema.NullOr(Schema.String)),
});

export const changeRoutes = guard({
  "/api/changes": {
    GET: () => runRoute(Effect.map(listChanges(), json)),
    // Creates the change, then gives it its presence: the checkouts (worktrees and branches made
    // at creation, so an agent works in them while the change is an idea) and the ticket assigned
    // to me. The change is written first, so a failing component leaves something to fix, not
    // nothing.
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = yield* bodyAs(req, CreateChangeBodySchema);
          const change = yield* createChange(body).pipe(Effect.mapError(changeError));
          // The plan the wizard collected, written as the change's own document. It is a file,
          // not a field of the draft: the agent and the dashboard edit the same file afterwards.
          if (typeof body.plan === "string" && body.plan) {
            yield* writeSidecar(change.id, PLAN_FILE, body.plan);
          }
          const run = yield* provisionRepositories(change).pipe(Effect.mapError(changeError));
          // A linked ticket is mine from the moment it is linked, not from the start.
          const jira = yield* assignTicketOnCreate(change);
          // Your own action lands on the stream at once, not within a tick.
          yield* Effect.sync(() => announce("changes"));
          // `changeDir` is the creation location: where a brand-new record is written. A change
          // that already exists stays where it was made when a root is overridden, so anything
          // that populates this for an existing change must use the stored directory
          // (`existingDir`), not `changeDir`.
          return json(
            {
              change,
              provision: [...run.provision, ...jira],
              refresh: run.refresh,
              changeDir: changeDir(change),
            },
            201,
          );
        }),
      ),
  },

  // What each change is called, refreshed from Jira in one query for the whole page. Its own
  // route, and not part of /api/changes: the list must stay instant, this waits for a CLI.
  "/api/titles": {
    GET: () => runRoute(Effect.map(refreshTitles(), json)),
  },

  "/api/changes/:id": {
    // Just the change: instant, no CLI calls, so the header renders immediately.
    GET: (req) => withChange(req.params.id, (c) => Effect.succeed(json(c))),
    // Only the fields you can edit by hand — its state and its name. Repositories have their
    // own endpoint, and the rest is either derived or the change's identity.
    PATCH: (req) =>
      withChange(req.params.id, (c) =>
        Effect.flatMap(bodyAs(req, PatchBody), (body) => Effect.map(patchChange(c, body), json)),
      ),
  },

  // An idea's plan: the text the wizard collected and the file the agent edits. A sidecar, so it
  // travels into the archive with the change. Read and written as text rather than through the
  // change record: it is a document, not a field. Every response carries the revision the text
  // has (`textRevision`), which is what a later edit is based on.
  "/api/changes/:id/plan": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.map(readSidecar(c.id, PLAN_FILE), (text) => json({ text, revision: textRevision(text) })),
      ),
    PUT: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          // A finished change's plan is a record: the card is read-only, and this is where that
          // is true rather than merely displayed.
          if (c.completedAt) {
            return yield* new BadRequestError({
              message: "this change is finished: its plan is read-only",
            });
          }
          const body = yield* bodyAs(req, PlanWriteBodySchema);
          const text = body.text ?? "";
          // An edit is based on the revision it read. A plan the agent or an IDE wrote since
          // then is not overwritten silently: the write is refused and the page re-reads. An
          // absent base revision writes unconditionally — creation and a deliberate overwrite.
          if (body.baseRevision !== undefined) {
            const current = textRevision(yield* readSidecar(c.id, PLAN_FILE));
            if (body.baseRevision !== current) {
              return yield* new ConflictError({
                message: "the plan changed on disk: reload it before saving",
              });
            }
          }
          yield* writeSidecar(c.id, PLAN_FILE, text);
          yield* Effect.sync(() => announce("changes"));
          return json({ text, revision: textRevision(text) });
        }),
      ),
  },

  // The repository list of a change, edited as a whole: the dialog sends the specs it wants.
  "/api/changes/:id/repos": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(repoStates(c), json)),
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, ReposBodySchema);
          const result = yield* setRepos(c, body.checkouts, body.force).pipe(Effect.mapError(changeError));
          // 409: nothing was changed, the browser should ask about the work left behind first.
          // Otherwise the answer is the same shape a create or a repository edit gives: the
          // change, and what its checkouts reported.
          return result._tag === "NeedsForce"
            ? json({ needsForce: result.needsForce, reasons: result.reasons }, 409)
            : json({ change: result.change, provision: result.provision, refresh: result.refresh });
        }),
      ),
  },

  // Text for a pull request, built here because the ticket summary comes from the Jira CLI.
  "/api/changes/:id/description": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(prDescription(c), (text) => json({ text }))),
  },

  // How far a completion got: written as it happens, so this answers even after a restart.
  "/api/changes/:id/completion/progress": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(progressOf(c.id), json)),
  },

  // Abandoning a change: the worktrees and the terminal go, and everything anyone else can
  // see — branches, pull requests, the ticket — is left alone and reported back.
  "/api/changes/:id/cancel": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, ForceBodySchema);
          const result = yield* cancelChange(c, body.force === true);
          // The same protocol a repository removal uses: ask once, then repeat with force. The
          // reasons say what would be thrown away, so the question can name it.
          return result._tag === "NeedsForce"
            ? json({ needsForce: result.needsForce, reasons: result.reasons }, 409)
            : json({ change: result.change, loose: result.loose });
        }),
      ),
  },

  // Undoing a cancellation: the change comes back from the archive in the phase it was cancelled
  // from, its worktrees are made again on the kept branches, and the work cancelling shelved is
  // applied to them. A completed change does not reopen.
  "/api/changes/:id/reopen": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const reopened = yield* reopenChange(c);
          yield* Effect.sync(() => announce("changes"));
          return json(reopened);
        }),
      ),
  },

  // The agent sessions kept with the change when it was archived, and one of them read for
  // display. The copies are the change's own files: listing them never asks a harness.
  "/api/changes/:id/transcripts": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const transcripts = yield* AgentTranscripts;
          const dir = yield* transcriptsDirOf(c.id);
          return json(yield* transcripts.list(dir).pipe(Effect.mapError(transcriptError)));
        }).pipe(Effect.provide(agentTranscriptsLayer)),
      ),
  },
  "/api/changes/:id/transcript": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const id = new URL(req.url).searchParams.get("id");
          if (!id) return yield* new BadRequestError({ message: "id required" });
          const transcripts = yield* AgentTranscripts;
          const dir = yield* transcriptsDirOf(c.id);
          return json(yield* transcripts.read(dir, id).pipe(Effect.mapError(transcriptError)));
        }).pipe(Effect.provide(agentTranscriptsLayer)),
      ),
  },

  // Completing a change: merge every outstanding pull request and close the ticket. The read
  // reports whether that is currently allowed, so the button can explain itself.
  "/api/changes/:id/completion": {
    // Whether it could be completed, for the menu item. A readiness check that cannot be made
    // — no GitHub remote, `gh` not logged in — is a reason it is not ready rather than a failed
    // request: swallowing the error would leave the tooltip with nothing to say, the least
    // useful of the three possible outcomes. The client polls this and the click path makes the
    // same live check; that one forgets the cached reads and fetches first, this one does not.
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.catch(Effect.map(completionOf(c), json), (e) =>
          Effect.succeed(json({ ready: false, reasons: [messageOf(e)], tagged: [], toMerge: [] })),
        ),
      ),
  },

  // The completion itself: the command, kept apart from the readiness read above so one path
  // answers a question and the other does the work.
  "/api/changes/:id/complete": {
    // The readiness check lives in `completeChange`: a change that is not ready and not forced
    // comes back as a refusal, which is a 409 carrying the tagged reasons so the dialog renders
    // server truth rather than the poll. One check per request, fetches included.
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.flatMap(bodyAs(req, ForceBodySchema), (body) => completePost(c, body)),
      ),
  },
});

/** A hand edit's work, apart from the request plumbing: the change the caller observed and the
 * patch. The write is conditional on the revision that read saw — inside the one record lock —
 * so an edit that loses a race is a 409 conflict and writes nothing, and an edit that wins is the
 * only one whose side effects run. Exported so a test can run two edits against the same observed
 * record and see the loser refused.
 *
 * The phase and the name are one write, deliberately: routing the phase half through
 * `ChangeService.transitionTo` would mix two stores writing the same file under two locks, and a
 * title that conflicted after the phase landed would leave the PATCH half applied. */
export const patchChange = (
  observed: Change,
  body: {
    state?: string;
    title?: string;
    userHarness?: string | null;
    subagentHarness?: string | null;
  },
): Effect.Effect<Change, CorviError> =>
  Effect.gen(function* () {
    // Naming the phase the change is already in is a no-op, and so is an empty body: either would
    // otherwise bump the revision and let the stamp below run for nothing.
    const stateChanges = body.state !== undefined && body.state !== (observed.state ?? "Implementation");
    const harnessChanges = body.userHarness !== undefined || body.subagentHarness !== undefined;
    if (!stateChanges && body.title === undefined && !harnessChanges) return observed;
    const updated = yield* Effect.try({
      try: () =>
        applyPatch(observed, {
          ...(stateChanges ? { state: body.state } : {}),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.userHarness === undefined ? {} : { userHarness: body.userHarness }),
          ...(body.subagentHarness === undefined ? {} : { subagentHarness: body.subagentHarness }),
        }),
      catch: changeError,
    });
    // The first departure from Ideation is the one that starts the work: `startedAt` is recorded
    // with the write, so a later return to Ideation and out again is a plain phase change — it
    // does not reassign the ticket or drag an advanced one backwards.
    const leavesIdeation = observed.state === "Ideation" && updated.state !== "Ideation";
    const firstStart = leavesIdeation && observed.startedAt === undefined;
    // A record that already stands outside Ideation has started, whatever it says: stamping the
    // fact on the way through covers records written before this field existed (and changes
    // created directly in a working phase), so a later round-trip cannot run the ticket move.
    // A finished record is not proof of anything: a change cancelled while still an idea must
    // keep its empty stamp, or reopening it to Ideation would suppress the ticket move for good.
    const needsStamp =
      observed.startedAt === undefined &&
      !isFinished(observed) &&
      (observed.state !== "Ideation" || leavesIdeation);
    const next = needsStamp ? { ...updated, startedAt: new Date().toISOString() } : updated;
    // The answer is the record that won on disk (with the revision it was given), never the
    // snapshot this edit was decided on.
    const winning = yield* writeChangeAt(next, observed.revision ?? 0).pipe(Effect.mapError(changeError));
    if (firstStart) {
      // After the write won and outside any checkout lock: a slow Jira never holds up the change,
      // and a failure is logged rather than thrown, so the phase change stands and the ticket
      // can be corrected from the Jira card. The response does wait for the move, though.
      const moved = yield* startTicket(winning);
      for (const result of moved)
        if (!result.ok)
          console.error(
            `could not move the ticket for ${winning.id}: ${result.error ?? result.detail ?? "failed"}`,
          );
      // The change may have finished while the move was in flight: the completion moved the
      // ticket to done, and this late start move puts it back. The record is authoritative, so
      // re-read it and put the done move back on top. Cancelling deliberately leaves the ticket
      // alone, so the only repair there is a line naming what to correct by hand.
      const after = yield* readChange(winning.id);
      if (after !== null && isFinished(after)) {
        if ((after.state ?? "Implementation") === "Cancelled") {
          console.error(
            `the ticket for ${winning.id} was moved to its start status after the change was ` +
              `cancelled: correct it in Jira`,
          );
        } else {
          const repaired = yield* finishTicket(after);
          for (const result of repaired)
            if (!result.ok)
              console.error(
                `could not move the ticket for ${winning.id} back to its done status: ` +
                  `${result.error ?? result.detail ?? "failed"}`,
              );
        }
      }
    }
    yield* Effect.sync(() => announce("changes"));
    return winning;
  });

/** The completion POST's work, apart from the request plumbing: run the completion, map a
 * `NotReady` verdict to the 409 the override dialog reads. Exported so a test can run it with a
 * scripted Shell, which `withChange`'s Promise shape does not allow. */
export const completePost = (
  change: Change,
  body: { force?: boolean },
): Effect.Effect<Response, CorviError, Changes> =>
  Effect.gen(function* () {
    const outcome = yield* completeChange(change, body.force === true);
    return outcome._tag === "NotReady"
      ? json(outcome.refusal, 409)
      : json({ change: outcome.change, notes: outcome.notes });
  });
