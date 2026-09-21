import { Effect } from "effect";
import {
  applyPatch,
  cancelChange,
  completeChange,
  completionOf,
  createChange,
  listChanges,
  PLAN_FILE,
  prDescription,
  progressOf,
  readSidecar,
  refreshTitles,
  startChangeWithWorkflow,
  writeChange,
  writeSidecar,
} from "../change/server/index.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { BadRequestError, type IweError } from "../capabilities/effect/errors.ts";
import { messageOf } from "../capabilities/effect/support.ts";
import type { Change } from "../domain/change.ts";
import type { Changes } from "../integrations/api/capabilities.ts";
import { announce } from "../capabilities/bus.ts";
import { repoStates, setRepos } from "../vendors/git.ts";
import { guard } from "../capabilities/web.ts";
import { workspaceOf } from "../workspace/server/index.ts";
import { attempt, bodyOf, bodyOrEmpty, json, withChange } from "../capabilities/web.ts";
import { provisionChangeRepositories } from "./provisioning.ts";

export const changeRoutes = guard({
  "/api/changes": {
    GET: () => runRoute(Effect.map(listChanges(), json)),
    // Creates the change, then provisions each component (worktrees, ticket status). The
    // change is written first, so a failing component leaves something to fix, not nothing.
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as Parameters<typeof createChange>[0] & {
            plan?: string;
          };
          const change = yield* createChange(body);
          // The plan the wizard collected, written as the change's own document. It is a file,
          // not a field of the draft: the agent and the dashboard edit the same file afterwards.
          if (typeof body.plan === "string" && body.plan) {
            yield* writeSidecar(change.id, PLAN_FILE, body.plan);
          }
          const provisioned = yield* provisionChangeRepositories(change);
          // Your own action lands on the stream at once, not within a tick.
          yield* Effect.sync(() => announce("changes"));
          return json({ change, provision: provisioned }, 201);
        }),
      ),
  },

  // What each change is called, refreshed from Jira in one query for the whole page. Its own
  // route, and not part of /api/changes: the list must stay instant, this waits for a CLI.
  "/api/titles": {
    GET: () => runRoute(Effect.map(refreshTitles(), json)),
  },

  // Starting an idea's work: the state moves to In Progress, then the start hooks create the
  // checkouts and move the ticket. Written first, like creation, so a failing component leaves
  // something to fix rather than nothing.
  "/api/changes/:id/start": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const started = yield* startChangeWithWorkflow(c);
          yield* Effect.sync(() => announce("changes"));
          return json(started);
        }),
      ),
  },

  "/api/changes/:id": {
    // Just the change: instant, no CLI calls, so the header renders immediately.
    GET: (req) => withChange(req.params.id, (c) => Effect.succeed(json(c))),
    // Only the fields you can edit by hand — its state and its name. Repositories have their
    // own endpoint, and the rest is either derived or the change's identity.
    PATCH: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as { state?: string; title?: string };
          const updated = yield* attempt(() => applyPatch(c, body));
          yield* writeChange(updated);
          yield* Effect.sync(() => announce("changes"));
          return json(updated);
        }),
      ),
  },

  // An idea's plan: the text the wizard collected and the file the agent edits. A sidecar, so it
  // travels into the archive with the change. Read and written as text rather than through the
  // change record: it is a document, not a field.
  "/api/changes/:id/plan": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.map(readSidecar(c.id, PLAN_FILE), (text) => json({ text })),
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
          const body = (yield* bodyOrEmpty(req)) as { text?: string };
          const text = typeof body.text === "string" ? body.text : "";
          yield* writeSidecar(c.id, PLAN_FILE, text);
          yield* Effect.sync(() => announce("changes"));
          return json({ text });
        }),
      ),
  },

  // The repository list of a change, edited as a whole: the dialog sends the list it wants.
  "/api/changes/:id/repos": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(repoStates(c), json)),
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as {
            repos: string[];
            direct?: string[];
            base?: Record<string, string>;
            force?: boolean;
          };
          const result = yield* setRepos(c, body.repos, body.force, body.direct, body.base);
          // 409: nothing was changed, the browser should ask about the unpushed work first.
          return result._tag === "NeedsForce"
            ? json({ needsForce: result.needsForce }, 409)
            : json(result.change);
        }),
      ),
  },

  // Text for a pull request, built here because the ticket summary comes from the Jira CLI.
  "/api/changes/:id/description": {
    GET: (req) =>
      withChange(req.params.id, (c) => Effect.map(prDescription(c), (text) => json({ text }))),
  },

  // Completing a change: merge every outstanding pull request and close the ticket. GET
  // reports whether that is currently allowed, so the button can explain itself.
  // How far a completion got: written as it happens, so this answers even after a restart.
  "/api/changes/:id/complete/progress": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(progressOf(c.id), json)),
  },

  // Abandoning a change: the worktrees and the terminal go, and everything anyone else can
  // see — branches, pull requests, the ticket — is left alone and reported back.
  "/api/changes/:id/cancel": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = (yield* bodyOrEmpty(req)) as { force?: boolean };
          const result = yield* cancelChange(c, body.force === true);
          // The same protocol a repository removal uses: ask once, then repeat with force.
          return result._tag === "NeedsForce"
            ? json({ needsForce: result.needsForce }, 409)
            : json({ change: result.change, loose: result.loose });
        }),
      ),
  },

  "/api/changes/:id/complete": {
    // Whether it could be completed, for the menu item. A readiness check that cannot be made
    // — no GitHub remote, `gh` not logged in — is a reason it is not ready rather than a failed
    // request: swallowing the error would leave the tooltip with nothing to say, the least
    // useful of the three possible outcomes. The client polls this and the click path makes the
    // same live check; that one forgets the cached reads and fetches first, this one does not.
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.catchAll(
          Effect.map(completionOf(c), json),
          (e) =>
            Effect.succeed(
              json({ ready: false, reasons: [messageOf(e)], tagged: [], toMerge: [] }),
            ),
        ),
      ),
    // The readiness check lives in `completeChange`: a change that is not ready and not forced
    // comes back as a refusal, which is a 409 carrying the tagged reasons so the dialog renders
    // server truth rather than the poll. One check per request, fetches included.
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.flatMap(
          bodyOrEmpty(req),
          (body) => completePost(c, body as { force?: boolean }),
        ),
      ),
  },
});

/** The completion POST's work, apart from the request plumbing: run the completion, map a
 * `NotReady` verdict to the 409 the override dialog reads. Exported so a test can run it with a
 * scripted Shell, which `withChange`'s Promise shape does not allow. */
export const completePost = (
  change: Change,
  body: { force?: boolean },
): Effect.Effect<Response, IweError, Changes> =>
  Effect.gen(function* () {
    const outcome = yield* completeChange(change, body.force === true);
    return outcome._tag === "NotReady"
      ? json(outcome.refusal, 409)
      : json({ change: outcome.change, notes: outcome.notes });
  });
