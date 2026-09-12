import { Effect } from "effect";
import { BadRequestError } from "../../capabilities/effect/errors.ts";
import { deployments, versionsFor, deploy } from "./server.ts";
import type { Extension } from "../../extension-host/api.ts";

/**
 * The deployments extension: what is deployed where, and the one irreversible thing on that
 * page.
 *
 * It contributes a page (the sidebar's Deployments entry, rendered by its client half) and the
 * three routes the page fetches from, under its own namespace. The implementation it wires up
 * — every `az` call, the cache, the promotion guard — lives beside it (./server.ts); this
 * module only describes it and hands it the workspace the request names.
 */

/** The context these pipelines belong to, said the way every route says it: a query parameter
 * the dispatcher honours too (it runs the handler as that workspace). */
const workspaceParam = (req: Request): string | undefined =>
  new URL(req.url).searchParams.get("workspace") ?? undefined;

/** The request body. A body that will not parse is the caller's mistake, said as the core's
 * routes say it: a BadRequestError, which the status-code mapping turns into a 400. */
const bodyOf = (req: Request): Effect.Effect<unknown, BadRequestError> =>
  Effect.tryPromise({
    try: () => req.json(),
    catch: (e) => new BadRequestError({ message: e instanceof Error ? e.message : String(e) }),
  });

export default {
  name: "deployments",
  title: "Deployments",

  // The page URL is the id: /deployments — the id is client-side view
  // state, not a server route.
  pages: [{ id: "deployments", title: "Deployments" }],

  // The per-workspace overrides of the same two names: shown in every workspace that has this
  // extension enabled, and stored under `workspace.extensionSettings.deployments` — the first
  // step of the chain the shared azure client reads (`azureOf`, src/vendors/azure.ts).
  workspaceSettings: [
    { key: "organization", label: "Organisation", placeholder: "the global setting" },
    { key: "project", label: "Project", placeholder: "the global setting" },
  ],

  // The server-wide settings this extension declares, shown on the settings page for every
  // workspace and stored under `extensionSettings.deployments`. The deployment conventions
  // (pipeline, versionParameter, environmentParameter, environments) are read back by
  // ./deploySettings.ts; organisation and project by the shared azure client's `azureOf`
  // (src/vendors/azure.ts), which adds the per-workspace override above and the core
  // config's `azure*` fields as the chain's fallback. An environment variable keeps beating the
  // page: the field shows locked when IWE_AZURE_* is set.
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
      handler: (req) => Effect.map(deployments(workspaceParam(req)), Response.json),
    },
    {
      // The versions a service has built and could be given, newest first.
      method: "GET",
      path: "/services/:service/versions",
      handler: (req, params) =>
        Effect.map(versionsFor(params.service!, workspaceParam(req)), Response.json),
    },
    {
      // The one irreversible thing on that page: start a deploy. The promotion guard — a later
      // environment gets a version only when the one before it holds it and succeeded — is the
      // implementation's own, and stays there.
      method: "POST",
      path: "/services/:service/deploy",
      handler: (req, params) =>
        Effect.gen(function* () {
          // A JSON body may be null or a primitive, not only an object: "no version or
          // environment to read" is the caller's mistake, whichever shape it arrived in.
          const body = (yield* bodyOf(req)) as { version?: string; environment?: string } | null;
          if (!body?.version || !body.environment) {
            return yield* new BadRequestError({ message: "version and environment required" });
          }
          return Response.json(
            yield* deploy(params.service!, body.version, body.environment, workspaceParam(req)),
          );
        }),
    },
  ],
} satisfies Extension;
