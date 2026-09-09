import { Effect, Schema } from "effect";
import type { WidgetState } from "./types.ts";
import { shEffect, type Result } from "./sh.ts";
import { swrEffect, invalidate } from "./cache.ts";
import { config } from "./config.ts";
import {
  azForEffect,
  buildUrl,
  versionOfEffect,
  expectedDurationEffect,
  type Az,
  type Definition,
} from "./integrations/azure.ts";
import { usesAzure, workspaceById } from "./workspaces.ts";
import { autoDeployedApp } from "./deployConventions.ts";
import { BadRequestError } from "./effect/errors.ts";

/** The Result-branching contract of the old sh(), kept: non-zero exits are data, so a timed-out
 * CLI — the one failure shEffect can raise — surfaces as exit code 124 with its message, which
 * is what the Promise facade converts it to. Result-branching callers keep branching. */
const shSoft = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  Effect.catchAll(shEffect(cmd, cwd), (e) =>
    Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr }));

/** `--json` output through the Schema, with the tolerance the old sh.ts json() had: a CLI that
 * printed nothing, or something this query did not expect, reads as the fallback rather than
 * failing — the documented silent fallback (docs/effect-conventions.md). */
const cliJson = <A, I, B extends A>(schema: Schema.Schema<A, I>, fallback: B) =>
  (stdout: string): Effect.Effect<B> =>
    stdout.trim()
      ? Effect.orElseSucceed(
          // JSON.parse produces mutable arrays at runtime; Schema's readonly type is tightened
          // back to the fallback's here, which is what the old cast did.
          Schema.decodeUnknown(Schema.parseJson(schema))(stdout) as Effect.Effect<B>,
          () => fallback,
        )
      : Effect.succeed(fallback);

/**
 * What is deployed where.
 *
 * The first part of IWE that is not about a change: you deploy a service's build to an
 * environment, and which change produced that build is a separate question — often somebody
 * else's. "What is on accept?" is asked before a release and during an incident, when there is
 * no change open to ask it from.
 *
 * Nothing is stored. A deploy run carries the version and the environment it was given
 * (`templateParameters`), so the last succeeded run per environment *is* the current state, and
 * Azure DevOps is the one keeping it. Our own record would only be a cache of that.
 */
export type Deployed = {
  environment: string;
  version?: string;
  /** When that deploy finished, or started if it is still going. */
  at?: string;
  /** Green when it is deployed, amber while it is deploying, red when the last attempt failed. */
  state: WidgetState;
  detail: string;
  url?: string;
};

export type Service = {
  /** What the pipelines call it: `example-service`. */
  name: string;
  pipeline: { id: number; name: string };
  /** The build pipeline this deploys, when there is one by the expected name. */
  build?: { id: number; name: string };
  environments: Deployed[];
};

export type Run = {
  id: number;
  buildNumber: string;
  status: string;
  result?: string | null;
  sourceBranch: string;
  startTime?: string | null;
  finishTime?: string | null;
  templateParameters?: Record<string, string> | null;
  definition?: { id?: number; name?: string };
};

/** `az pipelines runs list -o json` output for deploy pipelines, which carry the parameters the
 * run was given. */
const RunsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    buildNumber: Schema.String,
    status: Schema.String,
    result: Schema.optional(Schema.NullOr(Schema.String)),
    // Always present from az, but the old cast tolerated its absence; the default keeps that
    // tolerance without weakening the type.
    sourceBranch: Schema.optionalWith(Schema.String, { default: () => "" }),
    startTime: Schema.optional(Schema.NullOr(Schema.String)),
    finishTime: Schema.optional(Schema.NullOr(Schema.String)),
    templateParameters: Schema.optional(
      Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
    ),
    definition: Schema.optional(
      Schema.Struct({ id: Schema.optional(Schema.Number), name: Schema.optional(Schema.String) }),
    ),
  }),
);

/** A build that produced something deployable: what it was called, and what it made. */
export type Buildable = {
  runId: number;
  buildNumber: string;
  /** Undefined while the build is still running: the version is scraped from its logs, which do
   * not exist yet. */
  version?: string;
  branch: string;
  finishedAt?: string;
  url?: string;
  /** Where this version already is, so a version you are about to deploy says so first. */
  deployedTo: string[];
  /** Still building: shown so a deploy in progress does not look like it fell off the list, but
   * not something you can pick — there is no version yet to deploy. */
  running?: boolean;
  startedAt?: string;
  /** The recent average for this pipeline, for the same progress bar the CI widget draws. */
  expectedMs?: number;
};

/** Every pipeline in the project, which is how the deploy ones are found at all. Rarely changes;
 * shared with anything else that asks. */
const allPipelinesEffect = (az: Az): Effect.Effect<Definition[]> =>
  swrEffect(`az:${az.key}:pipelines`, 5 * 60_000,
    Effect.gen(function* () {
      const r = yield* shSoft(["az", "pipelines", "list", ...az.args, "-o", "json"]);
      return r.code === 0
        ? yield* cliJson(
          Schema.Array(
            Schema.Struct({ id: Schema.Number, name: Schema.String, path: Schema.String }),
          ),
          [] as Definition[],
        )(r.stdout)
        : [];
    }));

/** Runs of one pipeline, with the parameters they were given. Short-lived: a deploy you just
 * triggered should appear on the next look. */
const runsOfEffect = (az: Az, pipelineId: number): Effect.Effect<Run[]> =>
  swrEffect(`az:${az.key}:deploys:${pipelineId}`, 15_000,
    Effect.gen(function* () {
      const r = yield* shSoft([
        "az",
        "pipelines",
        "runs",
        "list",
        "--pipeline-ids",
        String(pipelineId),
        "--top",
        "50",
        ...az.args,
        "-o",
        "json",
      ]);
      return r.code === 0 ? yield* cliJson(RunsSchema, [] as Run[])(r.stdout) : [];
    }));

/** `build-example-service` → `deploy-example-service`, and the service name in between. */
// Pure and synchronous: nothing for an Effect to wrap.
export const serviceName = (deployPipeline: string): string => {
  const [, deploy] = config.azureDeploy.pipeline;
  return deployPipeline.startsWith(deploy) ? deployPipeline.slice(deploy.length) : deployPipeline;
};

// Pure and synchronous: nothing for an Effect to wrap.
export const buildPipelineName = (service: string): string =>
  `${config.azureDeploy.pipeline[0]}${service}`;

const ago = (iso?: string | null): string => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

// Pure and synchronous: nothing for an Effect to wrap.

/**
 * The version a deploy run was given.
 *
 * The parameter is not called the same thing everywhere — these pipelines use `dockerTag`, the
 * one that deploys the app uses `imageTag` — so the configured name is tried first and, failing
 * that, the only other parameter there is. A deploy run takes the environment and the thing to
 * deploy; when those are the only two, which is which is not a guess.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function versionIn(parameters: Record<string, string> | null | undefined): string | undefined {
  const { versionParameter, environmentParameter } = config.azureDeploy;
  const params = parameters ?? {};
  if (params[versionParameter]) return params[versionParameter];
  const others = Object.entries(params).filter(([key]) => key !== environmentParameter);
  return others.length === 1 ? others[0]![1] : undefined;
}

/**
 * What one environment of one service holds: the newest run that was given that environment.
 *
 * The newest run wins even when it failed or is still going, because that is the truth about the
 * environment — a failed deploy is news, and hiding it behind the last success would say the
 * environment is fine when somebody is looking at a red pipeline.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function latestFor(runs: Run[], environment: string): Deployed {
  const { environmentParameter } = config.azureDeploy;
  const mine = runs
    .filter((r) => (r.templateParameters ?? {})[environmentParameter] === environment)
    .sort((a, b) => b.id - a.id);

  const newest = mine[0];
  if (!newest) return { environment, state: "none", detail: "never deployed" };

  const version = versionIn(newest.templateParameters);
  const running = newest.status !== "completed";
  const failed = !running && newest.result !== "succeeded";
  // A failed deploy leaves the previous version running, so say which one that is.
  const holding = failed ? mine.find((r) => r.result === "succeeded") : undefined;

  return {
    environment,
    version: failed ? versionIn(holding?.templateParameters) : version,
    at: running ? (newest.startTime ?? undefined) : (newest.finishTime ?? undefined),
    state: running ? "pending" : failed ? "error" : "ok",
    detail: running
      ? `deploying ${version ?? "?"}`
      : failed
        ? `${version ?? "?"} failed ${ago(newest.finishTime)}`
        : ago(newest.finishTime),
    url: buildUrl(newest.id),
  };
}

/** Every service that has a deploy pipeline, and what each of its environments holds. */
export const deploymentsEffect = (
  workspaceId?: string,
): Effect.Effect<{ services: Service[]; error?: string }> =>
  Effect.gen(function* () {
    const workspace = workspaceById(workspaceId);
    if (!usesAzure(workspace)) return { services: [] }; // this context has no pipelines at all
    const az = yield* azForEffect(workspace);
    if (!az.project) {
      return { services: [], error: "no Azure DevOps project configured — run `az devops configure`" };
    }

    const pipelines = yield* allPipelinesEffect(az);
    if (pipelines.length === 0) return { services: [], error: "no pipelines found — is `az` logged in?" };

    const [, deployPrefix] = config.azureDeploy.pipeline;
    const byName = new Map(pipelines.map((p) => [p.name, p]));
    const deployPipelines = pipelines
      .filter((p) => p.name.startsWith(deployPrefix))
      .sort((a, b) => a.name.localeCompare(b.name));

    const services = yield* Effect.forEach(
      deployPipelines,
      (pipeline) =>
        Effect.gen(function* () {
          const name = serviceName(pipeline.name);
          const build = byName.get(buildPipelineName(name));
          const runs = yield* runsOfEffect(az, pipeline.id);
          return {
            name,
            pipeline: { id: pipeline.id, name: pipeline.name },
            build: build && { id: build.id, name: build.name },
            environments: config.azureDeploy.environments.map((e) => latestFor(runs, e)),
          } satisfies Service;
        }),
      // The old Promise.all was unbounded, so this stays unbounded.
      { concurrency: "unbounded" },
    );
    return { services };
  });


/** Recent successful builds of a service, with the version each produced.
 *
 * The version is scraped from the build's own logs — Azure records it nowhere else — which is
 * the same lookup the CI card makes, cached per run since a finished build's logs never change.
 * Five is enough: deploying something older than that is a rollback, and a rollback should be
 * deliberate enough to type.
 *
 * `*-app` services are the exception: they have no build pipeline to scrape, only a deploy
 * pipeline that builds and deploys straight to the first environment. What it deployed there is
 * read from that run's own parameters instead — the same place `latestFor` reads it from — so
 * promoting one never depends on a log line existing.
 */
export const versionsForEffect = (
  service: string,
  workspaceId?: string,
  howMany = 5,
): Effect.Effect<Buildable[]> =>
  Effect.gen(function* () {
    const workspace = workspaceById(workspaceId);
    if (!usesAzure(workspace)) return [];
    const az = yield* azForEffect(workspace);
    const project = az.project;
    const pipelines = yield* allPipelinesEffect(az);
    const deploy = pipelines.find((p) => p.name === deployPipelineName(service));

    if (autoDeployedApp(service)) {
      if (!deploy) return [];
      const runs = yield* runsOfEffect(az, deploy.id);
      const [accept] = config.azureDeploy.environments;
      const stillDeploying = runs.some(
        (r) =>
          r.status !== "completed" &&
          (r.templateParameters ?? {})[config.azureDeploy.environmentParameter] === accept,
      );
      const expectedMs = stillDeploying ? yield* expectedDurationEffect(az, deploy.id) : undefined;
      return acceptedVersions(runs, az, expectedMs, howMany);
    }

    const build = pipelines.find((p) => p.name === buildPipelineName(service));
    if (!build || !project) return [];

    const [runs, deployRuns] = yield* Effect.all([
      runsOfEffect(az, build.id),
      deploy ? runsOfEffect(az, deploy.id) : Effect.succeed([] as Run[]),
    ]);

    // In flight right now: not deployable — nothing has printed a version yet — but dropping them
    // from the list would make a build you are waiting on look like it never started.
    const building = runs
      .filter((r) => r.status !== "completed")
      .sort((a, b) => b.id - a.id);
    const expectedMs = building.length ? yield* expectedDurationEffect(az, build.id) : undefined;
    const inProgress: Buildable[] = building.map((run) => ({
      runId: run.id,
      buildNumber: run.buildNumber,
      branch: branchOf(run.sourceBranch),
      url: buildUrl(run.id, az),
      deployedTo: [],
      running: true,
      startedAt: run.startTime ?? undefined,
      expectedMs,
    }));

    const succeeded = runs
      .filter((r) => r.status === "completed" && r.result === "succeeded")
      .sort((a, b) => b.id - a.id)
      .slice(0, howMany);

    const versions = yield* Effect.all(
      succeeded.map((run) => Effect.map(versionOfEffect(run, project), (version) => ({ run, version }))),
      // The old Promise.all was unbounded, so this stays unbounded.
      { concurrency: "unbounded" },
    );

    const finished: Buildable[] = versions
      .filter((v): v is { run: Run; version: string } => Boolean(v.version))
      .map(({ run, version }) => ({
        runId: run.id,
        buildNumber: run.buildNumber,
        version,
        branch: branchOf(run.sourceBranch),
        finishedAt: run.finishTime ?? undefined,
        url: buildUrl(run.id, az),
        // Where it already is: deploying what is already there is usually a mistake, and saying so
        // costs nothing.
        deployedTo: config.azureDeploy.environments.filter(
          (e) => latestFor(deployRuns, e).version === version,
        ),
      }));

    return [...inProgress, ...finished];
  });

/** Promise facade over versionsForEffect, in the old signature. Kept for the test suite, which
 * must pass unmodified; the server uses the effect directly. */
export const versionsFor = (
  service: string,
  workspaceId?: string,
  howMany = 5,
): Promise<Buildable[]> => Effect.runPromise(versionsForEffect(service, workspaceId, howMany));

/**
 * `*-app` version history, read from the deploy pipeline's own runs to the first environment
 * rather than from build logs — see {@link versionsFor}.
 *
 * A run still deploying counts too, and with a real version rather than a placeholder: unlike a
 * build, a deploy run is given its version as a parameter before it starts, so there is nothing
 * to wait for. It still cannot be promoted anywhere until it succeeds, which its own state says.
 *
 * Pure and synchronous on purpose: the one thing that would need `az` — the expected duration —
 * is computed once by the caller and handed in, so this can be tested with plain arrays and
 * without a CLI in reach.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function acceptedVersions(
  runs: Run[],
  az: Az,
  expectedMs: number | undefined,
  howMany: number,
): Buildable[] {
  const [accept] = config.azureDeploy.environments;
  const { environmentParameter } = config.azureDeploy;
  const mine = runs
    .filter((r) => (r.templateParameters ?? {})[environmentParameter] === accept)
    .sort((a, b) => b.id - a.id);

  const seen = new Set<string>();
  const entries: Buildable[] = [];
  for (const run of mine) {
    const version = versionIn(run.templateParameters);
    if (!version || seen.has(version)) continue;
    seen.add(version);
    const running = run.status !== "completed";
    entries.push({
      runId: run.id,
      buildNumber: run.buildNumber,
      version,
      branch: branchOf(run.sourceBranch),
      finishedAt: run.finishTime ?? undefined,
      url: buildUrl(run.id, az),
      // The one environment this lookup ever sees is the one it just filtered to, so "deployed
      // to accept" is true by construction for anything found here at all.
      deployedTo: [accept!],
      running,
      startedAt: running ? (run.startTime ?? undefined) : undefined,
      expectedMs: running ? expectedMs : undefined,
    });
    if (entries.length >= howMany) break;
  }
  return entries;
}

/** What a build was built from, said the way you would say it: a branch by name, a pull request
 * by number. `refs/pull/169/merge` is a real answer to "which branch" and a useless one. */
// Pure and synchronous: nothing for an Effect to wrap.
export const branchOf = (ref: string | undefined): string => {
  const pull = /^refs\/pull\/(\d+)\//.exec(ref ?? "");
  if (pull) return `PR #${pull[1]}`;
  return (ref ?? "").replace(/^refs\/heads\//, "");
};

// Pure and synchronous: nothing for an Effect to wrap.
export const deployPipelineName = (service: string): string =>
  `${config.azureDeploy.pipeline[1]}${service}`;

/** The parameter this pipeline calls the version, learnt from what it was given last time. */
function versionParameterOf(runs: Run[]): string {
  const { versionParameter, environmentParameter } = config.azureDeploy;
  for (const run of runs) {
    const params = run.templateParameters ?? {};
    if (params[versionParameter]) return versionParameter;
    const others = Object.keys(params).filter((k) => k !== environmentParameter);
    if (others.length === 1) return others[0]!;
  }
  return versionParameter;
}

// Pure and synchronous: nothing for an Effect to wrap.

/**
 * Trigger a deploy. The one irreversible thing on this page.
 *
 * A later environment is only deployed to when the one before it already holds that exact
 * version and its run succeeded — which is the manual step the shell script asks you to do by
 * reading the acceptance logs, and the reason it is a step at all: production gets what
 * acceptance proved, not what somebody hoped.
 */
export const deployEffect = (
  service: string,
  version: string,
  environment: string,
  workspaceId?: string,
): Effect.Effect<{ runId: number; url?: string }, BadRequestError> =>
  Effect.gen(function* () {
    const { environments, environmentParameter } = config.azureDeploy;
    if (!environments.includes(environment)) {
      return yield* Effect.fail(
        new BadRequestError({ message: `unknown environment: ${environment}` }),
      );
    }
    const workspace = workspaceById(workspaceId);
    if (!usesAzure(workspace)) {
      return yield* Effect.fail(new BadRequestError({ message: `${workspace.name} has no pipelines` }));
    }
    const az = yield* azForEffect(workspace);
    const pipelines = yield* allPipelinesEffect(az);
    const pipeline = pipelines.find((p) => p.name === deployPipelineName(service));
    if (!pipeline) {
      return yield* Effect.fail(new BadRequestError({ message: `no deploy pipeline for ${service}` }));
    }

    const runs = yield* runsOfEffect(az, pipeline.id);
    const index = environments.indexOf(environment);
    if (index > 0) {
      const previous = environments[index - 1]!;
      const holds = latestFor(runs, previous);
      if (holds.version !== version || holds.state !== "ok") {
        return yield* Effect.fail(
          new BadRequestError({
            message:
              `${service}: ${version} is not on ${previous} (${holds.version ?? "nothing"} is, ${holds.detail}) — deploy it there first`,
          }),
        );
      }
    }

    const started = yield* shSoft([
      "az",
      "pipelines",
      "run",
      "--id",
      String(pipeline.id),
      "--parameters",
      `${versionParameterOf(runs)}=${version}`,
      `${environmentParameter}=${environment}`,
      ...az.args,
      "-o",
      "json",
    ]);
    if (started.code !== 0) {
      return yield* Effect.fail(
        new BadRequestError({
          message: started.stderr || started.stdout || "az pipelines run failed",
        }),
      );
    }

    const run = yield* cliJson(
      Schema.Struct({ id: Schema.optional(Schema.Number) }),
      {} as { id?: number },
    )(started.stdout);
    if (!run.id) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `could not read the run id from: ${started.stdout.slice(0, 200)}`,
        }),
      );
    }
    // The page asks Azure again on its next tick; forget what we knew a moment ago.
    invalidate(`az:${az.key}:deploys:${pipeline.id}`);
    return { runId: run.id, url: buildUrl(run.id, az) };
  });

/** Promise facade over deployEffect, in the old signature. Kept for the test suite, which must
 * pass unmodified; the server uses the effect directly. */
export const deploy = (
  service: string,
  version: string,
  environment: string,
  workspaceId?: string,
): Promise<{ runId: number; url?: string }> =>
  Effect.runPromise(deployEffect(service, version, environment, workspaceId));

