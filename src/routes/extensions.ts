import { Effect } from "effect";
import { BadRequestError, ConflictError, NotFoundError } from "../effect/errors.ts";
import {
  cardForExtension,
  cardsFor,
  dispatchExtensionRoute,
  pagesFor,
  repoStatusOfEffect,
  runCardEffect,
  statusOneEffect,
  wizardStepsFor,
} from "../extensions/index.ts";
import { guard } from "../origin.ts";
import { isFinished } from "../types.ts";
import { workspaceById } from "../workspaces.ts";
import {
  bodyOrEmpty,
  json,
  withChange,
  withWorkspaceParam,
  workspaceParam,
} from "./helpers.ts";

// What is deployed where moved under the deployments extension's namespace
// (/api/ext/deployments/…): the implementation (src/deployments.ts) stayed where it was,
// the routes and the page are the extension's own.

export const extensionsRoutes = guard({
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
  // deployed where is the deployments extension's page here, another extension's page
  // elsewhere. A context without the extension has no entry, not an empty one.
  "/api/pages": {
    GET: (req) =>
      withWorkspaceParam(
        req,
        Effect.succeed(json({ pages: pagesFor(workspaceById(workspaceParam(req))) })),
      ),
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
              wide: Boolean(card.wide),
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
            return yield* Effect.fail(new NotFoundError({ message: "unknown extension" }));
          }
          if (!repo) {
            return yield* Effect.fail(new BadRequestError({ message: "path required" }));
          }
          return json({ items: yield* repoStatusOfEffect(card, c, repo) });
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
            return yield* Effect.fail(new NotFoundError({ message: "unknown extension" }));
          }
          return json(yield* statusOneEffect(req.params.card, card, c));
        }),
      ),
  },

  "/api/changes/:id/:card/:action": {
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const card = cardForExtension(req.params.card);
          if (!card) {
            return yield* Effect.fail(new NotFoundError({ message: "unknown extension" }));
          }
          // The buttons are gone from a finished change's dashboard, but the page may have been
          // open since before it was finished — and this is where the truth lives.
          if (isFinished(c)) {
            return yield* Effect.fail(new ConflictError({ message: `${c.id} is finished` }));
          }
          const body = (yield* bodyOrEmpty(req)) as { arg?: string };
          yield* runCardEffect(card, c, req.params.action, body.arg);
          // Per-repository components answer with the rows of the repository acted on; the
          // argument of every such action is that repository.
          if (card.repoStatus && body.arg) {
            return json({ items: yield* repoStatusOfEffect(card, c, body.arg) });
          }
          return json(yield* statusOneEffect(req.params.card, card, c));
        }),
      ),
  },
});
