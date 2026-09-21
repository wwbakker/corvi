import { Effect } from "effect";
import { BadRequestError, ConflictError, NotFoundError } from "../capabilities/effect/errors.ts";
import {
  cardForExtension,
  cardsFor,
  changeTabsFor,
  dispatchExtensionRoute,
  pagesFor,
  repoStatusOf,
  runCard,
  statusOne,
  widgetsFor,
  wizardStepsFor,
} from "./index.ts";
import { guard } from "../capabilities/web.ts";
import { isFinished } from "../domain/change.ts";
import { workspaceById, workspaceOf } from "../workspace/server/index.ts";
import {
  bodyOrEmpty,
  json,
  withChange,
  withWorkspaceParam,
  workspaceParam,
} from "../capabilities/web.ts";

// What is deployed where lives under the azure-devops extension's namespace
// (/api/ext/azure-devops/…): the implementation (extensions/azure-devops/server.ts) lives with
// the extension, the routes and the page are the extension's own.

export const extensionHostRoutes = guard({
  // The steps the "Create change" wizard has in the context you are in: the extensions'
  // contributions, resolved per workspace. The page renders what it is told exists — which is
  // why a context without an extension has no step to show for it, not an empty one.
  "/api/wizard": {
    GET: (req) =>
      withWorkspaceParam(
        req,
        Effect.succeed(json({ steps: wizardStepsFor(workspaceById(workspaceParam(req))) })),
      ),
  },

  // The pages a context's sidebar offers, the same question one surface over: what is
  // deployed where is the azure-devops extension's page here, another extension's page
  // elsewhere. A context without the extension has no entry, not an empty one.
  "/api/pages": {
    GET: (req) =>
      withWorkspaceParam(
        req,
        Effect.succeed(json({ pages: pagesFor(workspaceById(workspaceParam(req))) })),
      ),
  },

  // The tabs this change's page offers: the core's own plus the extensions' for its workspace.
  // The page renders what it is told exists, exactly as the sidebar does with pages and the
  // wizard with steps — so a workspace without an extension has no tab for it, not an empty one.
  "/api/changes/:id/tabs": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.succeed(json({ tabs: changeTabsFor(workspaceOf(c)) })),
      ),
  },

  // The client-drawn widgets this change's dashboard shows: the extensions' for its
  // workspace, resolved the same way. A workspace without an extension has no widget for it,
  // not an empty one.
  "/api/changes/:id/widgets": {
    GET: (req) =>
      withChange(req.params.id, (c) => Effect.succeed(json({ widgets: widgetsFor(c) }))),
  },

  // Extension routes: whatever the extensions registered, under one namespace, with the same
  // origin guard as the rest and the workspace the request names. The wildcard is the whole
  // rest of the path — an extension's declared patterns may capture several segments
  // (/services/:service/versions) — and the dispatcher does its own matching on the pathname.
  // Unknown routes 404.
  "/api/ext/:name/*": async (req) =>
    (await dispatchExtensionRoute(req)) ?? new Response("no such extension route", { status: 404 }),

  // The components this change's dashboard shows: the ones its workspace has at all. The
  // browser asks each of them for its own widget, so one slow CLI cannot hold up the page.
  "/api/changes/:id/integrations": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.succeed(
          json(
            cardsFor(c).map(({ name, card }) => ({
              name,
              title: card.title,
              // Per-repository components are fetched a repository at a time by the browser.
              perRepo: Boolean(card.repoStatus),
              column: card.column ?? "right",
            })),
          ),
        ),
      ),
  },

  // One repository's rows of one component, so a change with many repositories fills in
  // one by one rather than all at once at the end.
  "/api/changes/:id/:card/repo": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const card = cardForExtension(req.params.card);
          const repo = new URL(req.url).searchParams.get("path");
          if (!card) {
            return yield* new NotFoundError({ message: "unknown extension" });
          }
          if (!repo) {
            return yield* new BadRequestError({ message: "path required" });
          }
          return json({ items: yield* repoStatusOf(req.params.card, card, c, repo) });
        }),
      ),
  },

  // One card's widget, fetched and refreshed independently by the browser.
  "/api/changes/:id/:card": {
    GET: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const card = cardForExtension(req.params.card);
          if (!card) {
            return yield* new NotFoundError({ message: "unknown extension" });
          }
          return json(yield* statusOne(req.params.card, card, c));
        }),
      ),
  },

  "/api/changes/:id/:card/:action": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const card = cardForExtension(req.params.card);
          if (!card) {
            return yield* new NotFoundError({ message: "unknown extension" });
          }
          // The buttons are gone from a finished change's dashboard, but the page may have been
          // open since before it was finished — and this is where the truth lives.
          if (isFinished(c)) {
            return yield* new ConflictError({ message: `${c.id} is finished` });
          }
          const body = (yield* bodyOrEmpty(req)) as { arg?: string };
          yield* runCard(req.params.card, card, c, req.params.action, body.arg);
          // Per-repository components answer with the rows of the repository acted on; the
          // argument of every such action is that repository.
          if (card.repoStatus && body.arg) {
            return json({ items: yield* repoStatusOf(req.params.card, card, c, body.arg) });
          }
          return json(yield* statusOne(req.params.card, card, c));
        }),
      ),
  },
});
