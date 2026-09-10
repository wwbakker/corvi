import { Effect } from "effect";
import {
  applyPatch,
  createChange,
  listChanges,
  readNotes,
  writeChange,
  writeNotes,
} from "../changes.ts";
import { cancelChange } from "../cancel.ts";
import { commitChange, pushChange, type CommitRequest } from "../commit.ts";
import { completeChange, completionOf, progressOf } from "../complete.ts";
import { prDescription } from "../description.ts";
import { BadRequestError } from "../effect/errors.ts";
import { runRoute } from "../effect/run.ts";
import { messageOf } from "../effect/support.ts";
import { Workspace } from "../effect/tags.ts";
import { announce } from "../events.ts";
import { provision } from "../extensions/index.ts";
import { repoStates, setRepos } from "../integrations/git.ts";
import { fileDiff, localChanges } from "../local.ts";
import { guard } from "../origin.ts";
import { summaryOf } from "../summary.ts";
import { refreshTitles } from "../titles.ts";
import { workspaceOf } from "../workspaces.ts";
import { attempt, bodyOf, bodyOrEmpty, json, withChange } from "./helpers.ts";

export const changesRoutes = guard({
  "/api/changes": {
    GET: () => runRoute(Effect.map(listChanges(), json)),
    // Creates the change, then provisions each component (worktrees, ticket status). The
    // change is written first, so a failing component leaves something to fix, not nothing.
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as Parameters<typeof createChange>[0];
          const change = yield* createChange(body);
          const provisioned = yield* Effect.provideService(
            provision(change),
            Workspace,
            workspaceOf(change),
          );
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

  // The facts a change's card on the overview shows — terminals from the core, the rest from
  // the extensions. One request per card, so a change whose CLIs are slow holds up only its
  // own card.
  "/api/changes/:id/summary": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(summaryOf(c), json)),
  },

  // What is uncommitted in one repository, and the diff of one file of it. Live: this is the
  // work you are doing, and a cached answer would be a wrong one.
  "/api/changes/:id/local": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const repo = new URL(req.url).searchParams.get("path");
          if (!repo) {
            return yield* Effect.fail(new BadRequestError({ message: "path required" }));
          }
          return json(yield* localChanges(c, repo));
        }),
      ),
  },

  // One commit per repository, with the same message: a change is one piece of work.
  "/api/changes/:id/commit": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          return json(yield* commitChange(c, (yield* bodyOf(req)) as CommitRequest));
        }),
      ),
  },

  // Pushing what is committed, in the repositories that have something to push.
  "/api/changes/:id/push": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as { repos?: string[] };
          return json(yield* pushChange(c, body.repos ?? c.repos));
        }),
      ),
  },

  "/api/changes/:id/local/diff": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const params = new URL(req.url).searchParams;
          const repo = params.get("path");
          const file = params.get("file");
          if (!repo || !file) {
            return yield* Effect.fail(new BadRequestError({ message: "path and file required" }));
          }
          return json({ text: yield* fileDiff(c, repo, file, params.get("staged") === "1") });
        }),
      ),
  },

  // Whatever you want to remember about this change; plain text in the change directory.
  "/api/changes/:id/notes": {
    GET: (req) =>
      withChange(req.params.id, (c) => Effect.map(readNotes(c.id), (text) => json({ text }))),
    PUT: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as { text?: string };
          yield* writeNotes(c.id, body.text ?? "");
          return json({ text: body.text ?? "" });
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
    // request: the page swallowed the error and disabled the item with nothing to say, which
    // is the least useful of the three possible outcomes.
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.catchAll(
          Effect.map(completionOf(c), json),
          (e) => Effect.succeed(json({ ready: false, reasons: [messageOf(e)], toMerge: [] })),
        ),
      ),
    POST: (req) => withChange(req.params.id, (c) => Effect.map(completeChange(c), json)),
  },
});
