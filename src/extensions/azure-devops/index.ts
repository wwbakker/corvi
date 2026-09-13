import { Effect } from "effect";
import { basename } from "node:path";
import type { Change } from "../../domain/change.ts";
import type { WidgetItem, WidgetState } from "../../domain/widget.ts";
import { Cache, Changes, Settings, Shell, Workspace, type Extension, type SummaryContribution } from "../../extension-host/api.ts";
import { BadRequestError } from "../../capabilities/effect/errors.ts";
import { deployments, versionsFor, deploy } from "./server.ts";
import { prNumberOf } from "../../vendors/github.ts";
import { activeRuns, pipelineItems } from "./pipelines.ts";
import { AZURE_ENV } from "./legacy.ts";
import { DEPLOY_ENVIRONMENTS_ENV } from "./deploySettings.ts";

/**
 * The azure-devops extension: pipelines and deployments, from the one vendor.
 *
 * It contributes a card (one row per pipeline of each repository, with its runs as children),
 * a page (the sidebar's Azure DevOps entry, rendered by its client half) and the routes the
 * page fetches from, under its own namespace. The implementation it wires up — every `az`
 * call, the cache, the promotion guard — lives beside it (./pipelines.ts for the per-change
 * facts, ./server.ts for the deployments page, ./azure.ts for which Azure DevOps is meant);
 * this module only describes it.
 */

/** The request body. A body that will not parse is the caller's mistake, said as the core's
 * routes say it: a BadRequestError, which the status-code mapping turns into a 400. */
const bodyOf = (req: Request): Effect.Effect<unknown, BadRequestError> =>
  Effect.tryPromise({
    try: () => req.json(),
    catch: (e) => new BadRequestError({ message: e instanceof Error ? e.message : String(e) }),
  });

/** repository > pipelines > runs, as one collapsible tree per repository. Pipelines run on the
 * PR merge ref once a PR exists, so the pull request number is looked up first through the
 * shared cached query the GitHub card makes. */
const repoItem = (
  change: Change,
  repo: string,
): Effect.Effect<WidgetItem[], never, Shell | Workspace | Cache | Settings | Changes> =>
  Effect.gen(function* () {
    const number = yield* prNumberOf(change, repo);
    const { items } = yield* pipelineItems(change, repo, number);
    if (items.length === 0) return [];
    return [{
      label: basename(repo),
      state: worstItem(items),
      children: items,
    }];
  });

/** The item-level variant of domain/widget.ts's `worst`: it reduces `WidgetItem[]` by their state, so a
 * card can pick a verdict from its own rows as well as from a list of states. */
const worstItem = (items: WidgetItem[]): WidgetState =>
  items.some((i) => i.state === "error")
    ? "error"
    : items.some((i) => i.state === "pending")
      ? "pending"
      : items.some((i) => i.state === "warn")
        ? "warn"
        : items.some((i) => i.state === "ok")
          ? "ok"
          : "none";

/**
 * The facts the change's overview card shows beyond its terminals: how many pipelines are in
 * flight, per repository in parallel. The pull request number comes from the same cached lookup
 * the card makes. A repository's vendor being down is the contributor's own failure, which the
 * host swallows: the card loses the facts, not the request.
 */
const summaryContribution = (
  change: Change,
): Effect.Effect<SummaryContribution, unknown, Shell | Workspace | Cache | Settings | Changes> =>
  Effect.gen(function* () {
    const perRepo = yield* Effect.forEach(
      change.repos,
      (repo) =>
        Effect.gen(function* () {
          const number = yield* prNumberOf(change, repo);
          return yield* activeRuns(change, repo, number);
        }),
      { concurrency: "unbounded" },
    );
    const pipelines = perRepo.reduce((n, r) => n + r, 0);
    return {
      facts: [
        {
          id: "pipelines",
          label:
            pipelines > 0
              ? `${pipelines} pipeline${pipelines === 1 ? "" : "s"} active`
              : "pipelines idle",
          state: pipelines > 0 ? "pending" : "none",
        },
      ],
      // A pipeline in flight is a build running, whatever the pull request's checks say about
      // the last one.
      state: pipelines > 0 ? ("pending" as WidgetState) : undefined,
    };
  });

export default {
  name: "azure-devops",
  title: "Azure DevOps",

  cards: [
    {
      title: "Azure DevOps",
      repoStatus: (change, repo) => repoItem(change, repo),
    },
  ],

  summaryContributions: [{ facts: summaryContribution }],

  // The page URL is the id: /azure-devops — the id is client-side view
  // state, not a server route.
  pages: [{ id: "azure-devops", title: "Azure DevOps" }],

  // The per-workspace overrides of the same two names: shown in every workspace that has this
  // extension enabled, and stored under `workspace.extensionSettings.azure-devops` — the first
  // step of the chain azure.ts reads.
  workspaceSettings: [
    { key: "organization", label: "Organisation", placeholder: "the global setting" },
    { key: "project", label: "Project", placeholder: "the global setting" },
  ],

  // The server-wide settings this extension declares, shown on the settings page for every
  // workspace and stored under `extensionSettings.azure-devops`. The deployment conventions
  // (pipeline, versionParameter, environmentParameter, environments) are read back by
  // ./deploySettings.ts; organisation and project by ./azure.ts, which adds the per-workspace
  // override above and the legacy `azure*` fields as the chain's fallback. An environment
  // variable keeps beating the page: the field shows locked when IWE_AZURE_* is set.
  globalSettings: [
    { key: "organization", label: "Organisation", placeholder: "whatever az devops configure holds", env: AZURE_ENV.organization },
    { key: "project", label: "Project", placeholder: "whatever az devops configure holds", env: AZURE_ENV.project },
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
      env: DEPLOY_ENVIRONMENTS_ENV,
    },
  ],

  routes: [
    {
      // The workspace arrives through the `Workspace` capability: the dispatcher provides it
      // from the request's `workspace` parameter, so the handlers name no workspace themselves.
      method: "GET",
      path: "/services",
      handler: () => Effect.map(deployments(), Response.json),
    },
    {
      // The versions a service has built and could be given, newest first.
      method: "GET",
      path: "/services/:service/versions",
      handler: (_req, params) =>
        Effect.map(versionsFor(params.service!), Response.json),
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
            yield* deploy(params.service!, body.version, body.environment),
          );
        }),
    },
  ],
} satisfies Extension;

