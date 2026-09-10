import { Effect } from "effect";
import { BadRequestError } from "../../effect/errors.ts";
import { deploymentsEffect, versionsForEffect, deployEffect } from "../../deployments.ts";
import type { Extension } from "../api.ts";

/**
 * The deployments extension: what is deployed where, and the one irreversible thing on that
 * page.
 *
 * It contributes a page (the sidebar's Deployments entry, rendered by its client half) and the
 * three routes the page fetches from, under its own namespace. The implementation it wires up
 * — every `az` call, the cache, the promotion guard — lives where it always has
 * (src/deployments.ts); this module only describes it and hands it the workspace the request
 * names.
 */

/** The context these pipelines belong to, said the way every route says it: a query parameter
 * the dispatcher honours too (it runs the handler as that workspace). */
const workspaceParam = (req: Request): string | undefined =>
  new URL(req.url).searchParams.get("workspace") ?? undefined;

/** The request body. A body that will not parse is the caller's mistake, said as the core's
 * routes say it: a BadRequestError, which the status-code mapping turns into a 400. */
const bodyOf = (req: Request): Effect.Effect<unknown, BadRequestError> =>
  Effect.mapError(
    Effect.tryPromise({ try: () => req.json(), catch: (e) => e }),
    (e) => new BadRequestError({ message: e instanceof Error ? e.message : String(e) }),
  );

export default {
  name: "deployments",
  title: "Deployments",

  // The page URL is the id: /deployments, where it always was — the id is client-side view
  // state, not a server route.
  pages: [{ id: "deployments", title: "Deployments" }],

  // The server-wide settings this extension declares, shown on the settings page for every
  // workspace and stored under `extensionSettings.deployments` — where deploySettings reads
  // them back (src/deploySettings.ts), with the legacy config fields as the fallback chain's
  // tail. An environment variable keeps beating the page: the field shows locked when
  // IWE_AZURE_* is set.
  globalSettings: [
    { key: "organization", label: "Organisation", placeholder: "whatever az devops configure holds", env: "IWE_AZURE_ORG" },
    { key: "project", label: "Project", placeholder: "whatever az devops configure holds", env: "IWE_AZURE_PROJECT" },
    {
      key: "pipeline",
      label: "How a build pipeline is named, and its deploy twin",
      hint: "Two names in order: build-example-api deploys through deploy-example-api.",
      list: true,
    },
    {
      key: "versionParameter",
      label: "Version parameter",
      hint:
        "Learnt per pipeline when this name does not fit: a pipeline with one other parameter is telling you which it is.",
    },
    { key: "environmentParameter", label: "Environment parameter" },
    {
      key: "environments",
      label: "Environments",
      hint:
        "In the order they are deployed to, which is the order the page shows them and the order promotion follows.",
      list: true,
      env: "IWE_AZURE_ENVIRONMENTS",
    },
  ],

  routes: [
    {
      method: "GET",
      path: "/services",
      handler: (req) => Effect.map(deploymentsEffect(workspaceParam(req)), Response.json),
    },
    {
      // The versions a service has built and could be given, newest first.
      method: "GET",
      path: "/services/:service/versions",
      handler: (req, params) =>
        Effect.map(versionsForEffect(params.service!, workspaceParam(req)), Response.json),
    },
    {
      // The one irreversible thing on that page: start a deploy. The promotion guard — a later
      // environment gets a version only when the one before it holds it and succeeded — is the
      // implementation's own, and stays there.
      method: "POST",
      path: "/services/:service/deploy",
      handler: (req, params) =>
        Effect.gen(function* () {
          const body = (yield* bodyOf(req)) as { version?: string; environment?: string };
          if (!body.version || !body.environment) {
            return yield* Effect.fail(
              new BadRequestError({ message: "version and environment required" }),
            );
          }
          return Response.json(
            yield* deployEffect(params.service!, body.version, body.environment, workspaceParam(req)),
          );
        }),
    },
  ],
} satisfies Extension;
