import { basename } from "node:path";
import { Effect, Schema } from "effect";
import { worst } from "../domain/widget.ts";
import type { Change } from "../domain/change.ts";
import type { WidgetItem, WidgetState } from "../domain/widget.ts";
import { swr } from "../platform/capabilities/cache.ts";
import type { Workspace } from "../domain/config.ts";
import { azureOf, usesAzure, workspaceOf } from "../../workspace/server/index.ts";
import { deploySettings } from "../../deploySettings.ts";
import { cliJson, shSoft } from "../platform/effect/support.ts";

export type Run = {
  id: number;
  buildNumber: string;
  status: string;
  result?: string | null;
  sourceBranch: string;
  startTime?: string | null;
  finishTime?: string | null;
  definition?: { id?: number; name?: string };
};

export type Definition = { id: number; name: string; path: string };

/** `az pipelines list -o json` output, as far as this file reads it. */
const DefinitionsSchema = Schema.Array(
  Schema.Struct({ id: Schema.Number, name: Schema.String, path: Schema.String }),
);

/** `az pipelines runs list -o json` output, as far as this file reads it. */
const RunsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    buildNumber: Schema.String,
    status: Schema.String,
    result: Schema.optional(Schema.NullOr(Schema.String)),
    // Always present from az, but absence is tolerated with an empty default.
    sourceBranch: Schema.optionalWith(Schema.String, { default: () => "" }),
    startTime: Schema.optional(Schema.NullOr(Schema.String)),
    finishTime: Schema.optional(Schema.NullOr(Schema.String)),
    definition: Schema.optional(
      Schema.Struct({ id: Schema.optional(Schema.Number), name: Schema.optional(Schema.String) }),
    ),
  }),
);

/** How many finished runs the duration estimate averages over. Branches differ, but the same
 * pipeline on the same agents is the best predictor available. */
const historySize = (): string => process.env.IWE_AZURE_HISTORY ?? "10";

/** Runs shown per pipeline. The newest is what you look at; the rest are history. */
const runsPerPipeline = (): number => Number(process.env.IWE_AZURE_RUNS ?? 3);

/** Organisation and project default to whatever `az devops configure` already holds, so the
 * Azure CLI stays the single place this is configured. */
let defaults: { organization?: string; project?: string } | null = null;

export const azDefaults = (): Effect.Effect<{ organization?: string; project?: string }> =>
  Effect.suspend(() => {
    if (defaults) return Effect.succeed(defaults);
    return Effect.gen(function* () {
      const r = yield* shSoft(["az", "devops", "configure", "-l"]);
      const read = (key: string): string | undefined =>
        new RegExp(`^${key}\\s*=\\s*(\\S+)`, "m").exec(r.stdout)?.[1];
      defaults = {
        // The deployments extension's own setting wins; the legacy config field (which resolves
        // the environment variable) is the fallback, then az devops configure.
        organization: deploySettings().organization || read("organization"),
        project: deploySettings().project || read("project"),
      };
      return defaults;
    });
  });

/**
 * Which Azure DevOps this workspace means, and how to say so on a command line.
 *
 * `az` has one configured default organisation and project, which is fine until a second client
 * turns up. A workspace that names its own gets them passed explicitly; one that does not falls
 * back to `az devops configure`.
 *
 * The key namespaces the cache: two organisations answering the same question differently is
 * exactly the bug this prevents.
 */
export type Az = { key: string; args: string[]; organization?: string; project?: string };

export const azFor = (workspace: Workspace): Effect.Effect<Az> =>
  Effect.gen(function* () {
    const own = azureOf(workspace);
    const fallback = yield* azDefaults();
    const organization = own.organization || fallback.organization;
    const project = own.project || fallback.project;
    return {
      key: workspace.id,
      args: [
        ...(organization ? ["--organization", organization] : []),
        ...(project ? ["--project", project] : []),
      ],
      organization,
      project,
    };
  });


/** A queued or running build is pending; anything but success is a problem worth a red dot. */
// Pure and synchronous: nothing for an Effect to wrap.
export function runState(run: Run): WidgetState {
  if (run.status !== "completed") return "pending";
  switch (run.result) {
    case "succeeded":
      return "ok";
    case "partiallySucceeded":
    case "canceled":
      return "warn";
    default:
      return "error";
  }
}

/** Both refs a change's builds can run on. Pull request validation builds run on the merge ref,
 * while CI-triggered pipelines (publishing a client, for instance) keep running on the branch,
 * so asking for only one of them hides half the builds once a pull request exists. */
export const refsFor = (branch: string, pr?: number): string[] =>
  pr
    ? [`refs/pull/${pr}/merge`, `refs/heads/${branch}`]
    : [`refs/heads/${branch}`];

// Pure and synchronous: nothing for an Effect to wrap.

/** Azure DevOps pipeline folders mirror the service directories of a monorepo (`\service-x`),
 * which is how runs are attributed to a repository: `repository.name` comes back null. */
export const folderFor = (repo: string): string => `\\${basename(repo)}`;

// Pure and synchronous: nothing for an Effect to wrap.

/*
 * One call per distinct question, however many rows ask it: every repository of a change asks
 * Azure DevOps about the same branch at the same moment, and `az` costs a few hundred
 * milliseconds of CPU per invocation — it is a Python program, started afresh each time. The
 * sharing and the staleness both live in src/core/platform/capabilities/cache.ts.
 */

/** Pipelines are moved between folders about never; runs happen while you watch. Both are
 * served from the cache while the refresh runs, so neither number is ever waited for twice. */
const DEFINITIONS_TTL = 5 * 60_000;
const RUNS_TTL = 10_000;

const listDefinitions = (az: Az, repo: string): Effect.Effect<Definition[]> =>
  swr(`az:${az.key}:definitions:${folderFor(repo)}`, DEFINITIONS_TTL,
    Effect.gen(function* () {
      const r = yield* shSoft([
        "az",
        "pipelines",
        "list",
        "--folder-path",
        folderFor(repo),
        ...az.args,
        "-o",
        "json",
      ]);
      return r.code === 0 ? yield* cliJson(DefinitionsSchema, [] as Definition[])(r.stdout) : [];
    }));

const runsFor = (az: Az, refs: string[]): Effect.Effect<{ runs: Run[]; error?: string }> =>
  Effect.gen(function* () {
    // One query per ref; grouping per pipeline happens here rather than in a query per pipeline.
    // The branch ref is the same for every repository of a change, so this is asked six times at
    // once and answered once.
    const results = yield* Effect.all(
      refs.map((ref) =>
        swr(`az:${az.key}:runs:${ref}`, RUNS_TTL, shSoft([
          "az",
          "pipelines",
          "runs",
          "list",
          "--branch",
          ref,
          "--top",
          "50",
          ...az.args,
          "-o",
          "json",
        ])),
      ),
      // Unbounded: the shared CLI semaphore caps how many of these run at once.
      { concurrency: "unbounded" },
    );
    const failed = results.find((r) => r.code !== 0);
    if (failed) return { runs: [], error: (failed.stderr || failed.stdout).split("\n")[0] };
    const byId = new Map<number, Run>();
    for (const r of results) {
      for (const run of yield* cliJson(RunsSchema, [] as Run[])(r.stdout)) {
        byId.set(run.id, run);
      }
    }
    // Newest first, so slicing per pipeline keeps the most recent runs.
    return { runs: [...byId.values()].sort((a, b) => b.id - a.id) };
  });

/**
 * How many runs of this repository's pipelines are in flight for this change — the one number
 * the overview needs. Both queries behind it are the cached ones the dashboard uses, so asking
 * for it costs nothing extra while a change is open, and it skips durations, logs and versions.
 */
export const activeRuns = (change: Change, repo: string, pr?: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const workspace = workspaceOf(change);
    if (!usesAzure(workspace)) return 0; // a context without pipelines has none running
    const az = yield* azFor(workspace);
    const [definitions, { runs, error }] = yield* Effect.all([
      listDefinitions(az, repo),
      runsFor(az, refsFor(change.branch, pr)),
    ]);
    if (error) return 0;
    const mine = new Set(definitions.map((d) => d.id));
    return runs.filter((r) => {
      const id = r.definition?.id;
      return r.status !== "completed" && id !== undefined && mine.has(id);
    }).length;
  });


/** Mean duration of the last finished runs of a pipeline, across branches. */
// Pure and synchronous: nothing for an Effect to wrap.
export function averageDuration(runs: Run[]): number | undefined {
  const durations = runs
    .map((r) =>
      r.startTime && r.finishTime
        ? new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()
        : 0
    )
    .filter((ms) => ms > 0);
  if (durations.length === 0) return undefined;
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

export const expectedDuration = (az: Az, definitionId: number): Effect.Effect<number | undefined> =>
  swr(`az:${az.key}:duration:${definitionId}`, DEFINITIONS_TTL,
    Effect.gen(function* () {
      const r = yield* shSoft([
        "az",
        "pipelines",
        "runs",
        "list",
        "--pipeline-ids",
        String(definitionId),
        "--status",
        "completed",
        "--top",
        historySize(),
        "-o",
        "json",
      ]);
      return r.code === 0
        ? averageDuration(yield* cliJson(RunsSchema, [] as Run[])(r.stdout))
        : undefined;
    }));


/** The artifact version a build produced, as printed by the pipelines themselves. */
const VERSION_PATTERNS = [
  /Version is: '([^']+)'/,
  // Deliberately loose: docker prints the tag after a full image reference
  // ("pushing manifest for registry/app:20260818.4"), which a \b anchor would miss.
  /pushing manifest for \S*?([0-9]{8}\.\d+)\b/,
  /Built and pushed image as .*:([0-9]{8}\.\d+)\b/,
];

// Pure and synchronous: nothing for an Effect to wrap.
export function versionInLines(lines: string[]): string | undefined {
  for (const line of lines) {
    for (const pattern of VERSION_PATTERNS) {
      const match = pattern.exec(line);
      if (match) return match[1];
    }
  }
  return undefined;
}

/** Log ids of a run, newest step last. */
const logIds = (project: string, pipelineId: number, runId: number): Effect.Effect<number[]> =>
  Effect.gen(function* () {
    const r = yield* shSoft([
      "az",
      "devops",
      "invoke",
      "--area",
      "pipelines",
      "--resource",
      "logs",
      "--api-version",
      "7.0",
      "--route-parameters",
      `project=${project}`,
      `pipelineId=${pipelineId}`,
      `runId=${runId}`,
      "-o",
      "json",
    ]);
    if (r.code !== 0) return [];
    const parsed = yield* cliJson(
      Schema.Struct({ logs: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Number }))) }),
      {} as { logs?: { id: number }[] },
    )(r.stdout);
    return parsed.logs?.map((l) => l.id) ?? [];
  });

const logLines = (project: string, runId: number, logId: number): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const r = yield* shSoft([
      "az",
      "devops",
      "invoke",
      "--area",
      "build",
      "--resource",
      "logs",
      "--api-version",
      "7.0",
      "--route-parameters",
      `project=${project}`,
      `buildId=${runId}`,
      `logId=${logId}`,
      "-o",
      "json",
    ]);
    return r.code === 0
      ? yield* Effect.map(
        cliJson(
          Schema.Struct({ value: Schema.optional(Schema.Array(Schema.String)) }),
          {} as { value?: string[] },
        )(r.stdout),
        (v) => v.value ?? [],
      )
      : [];
  });

/** A finished run's logs never change, so a version is looked up once and kept. */
const versions = new Map<number, string | undefined>();

export const versionOf = (run: Run, project: string): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    // Only successful builds produced an artifact worth naming.
    if (run.status !== "completed" || run.result !== "succeeded") return Effect.sync(() => undefined);
    if (versions.has(run.id)) return Effect.succeed(versions.get(run.id));

    const pipelineId = run.definition?.id;
    return Effect.gen(function* () {
      const version = pipelineId ? yield* findVersion(project, pipelineId, run.id) : undefined;
      versions.set(run.id, version);
      return version;
    });
  });


const findVersion = (
  project: string,
  pipelineId: number,
  runId: number,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    // Publishing happens at the end of a build, so the last steps are searched first: in practice
    // the version turns up in the first batch. ponytail: batches of 5, widen if it ever drags.
    const ids = (yield* logIds(project, pipelineId, runId)).sort((a, b) => b - a);
    for (let i = 0; i < ids.length; i += 5) {
      const batch = yield* Effect.all(
        ids.slice(i, i + 5).map((id) =>
          Effect.map(logLines(project, runId, id), (lines) => versionInLines(lines))
        ),
        // Unbounded: the shared CLI semaphore caps how many of these run at once.
        { concurrency: "unbounded" },
      );
      const found = batch.find(Boolean);
      if (found) return found;
    }
    return undefined;
  });

// Pure and synchronous: nothing for an Effect to wrap.

/** Where a run can be looked at in Azure DevOps. Undefined when we do not know the
 * organisation or project, which is the same condition that makes everything else here empty. */
export function buildUrl(id: number, az?: Az): string | undefined {
  const { organization, project } = az ?? defaults ?? {};
  return organization && project
    ? `${organization}/${encodeURIComponent(project)}/_build/results?buildId=${id}`
    : undefined;
}

// Pure and synchronous: nothing for an Effect to wrap.

/** One row per pipeline of this repository, with its runs for this ref as children. */
export const pipelineItems = (
  change: Change,
  repo: string,
  pr?: number,
): Effect.Effect<{ items: WidgetItem[]; count: number }> =>
  Effect.gen(function* () {
    const workspace = workspaceOf(change);
    // A context without pipelines is not an empty list of them, it is silence: the card shows the
    // pull request and nothing else, and no `az` process is started.
    if (!usesAzure(workspace)) return { items: [], count: 0 };
    const az = yield* azFor(workspace);
    const refs = refsFor(change.branch, pr);
    const [definitions, { runs, error }] = yield* Effect.all([
      listDefinitions(az, repo),
      runsFor(az, refs),
    ]);
    if (error) {
      return {
        items: [{ label: "pipelines", detail: error, state: "error" }],
        count: 0,
      };
    }

    const { project } = az;
    const url = (id: number): string | undefined => buildUrl(id, az);

    // Definitions come from this repository's folder; runs that match none of them are ignored,
    // which is what keeps a monorepo's other services out of this widget.
    const byDefinition = new Map<number, Run[]>(definitions.map((d) => [d.id, []]));
    for (const run of runs) {
      const id = run.definition?.id;
      if (id !== undefined && byDefinition.has(id)) byDefinition.get(id)!.push(run);
    }

    let count = 0;
    // Only pipelines with something in flight need a duration estimate, so the extra query is
    // paid for exactly when there is a progress bar to draw.
    const running = definitions.filter((d) =>
      (byDefinition.get(d.id) ?? []).some((run) => run.status !== "completed")
    );
    const expected = new Map(
      yield* Effect.all(
        running.map((d) => Effect.map(expectedDuration(az, d.id), (ms): [number, number | undefined] => [d.id, ms])),
        // Unbounded: the shared CLI semaphore caps how many of these run at once.
        { concurrency: "unbounded" },
      ),
    );

    const items: WidgetItem[] = yield* Effect.all(
      definitions.map((definition) =>
        Effect.gen(function* () {
          const mine = (byDefinition.get(definition.id) ?? []).slice(0, runsPerPipeline());
          count += mine.length;
          const children = mine.map((run): WidgetItem => {
            const done = run.status === "completed";
            return {
              label: run.buildNumber,
              detail: done ? (run.result ?? "completed") : run.status,
              url: url(run.id),
              state: runState(run),
              // A finished build is as old as its finish time. A running one says nothing here:
              // its progress bar is already counting the same seconds, from the same moment.
              at: done ? ((run.finishTime ?? run.startTime) ?? undefined) : undefined,
              progress:
                !done && run.startTime
                  ? {
                    startedAt: run.startTime,
                    expectedMs: expected.get(definition.id),
                  }
                  : undefined,
            };
          });
          // The version each successful build produced, read from its logs.
          if (project) {
            yield* Effect.forEach(
              mine.map((run, index) => ({ run, index })),
              ({ run, index }) =>
                Effect.gen(function* () {
                  const version = yield* versionOf(run, project);
                  const child = children[index]!;
                  if (version) {
                    child.detail = [child.detail, version].filter(Boolean).join(" · ");
                  }
                }),
              // Unbounded: the shared CLI semaphore caps how many of these run at once.
              { concurrency: "unbounded", discard: true },
            );
          }
          return {
            label: definition.name,
            // Runs speak for themselves when listed; their absence does not.
            detail: children.length
              ? undefined
              : `no runs for ${pr ? "this pull request or branch" : "this branch"}`,
            // The newest run is the truth about a pipeline: an older failure that a later run fixed
            // must not keep the dot red. The failed run keeps its own red dot in the list.
            state: children[0]?.state ?? "none",
            children,
          };
        }),
      ),
      // Unbounded: the shared CLI semaphore caps how many of these run at once.
      { concurrency: "unbounded" },
    );

    if (items.length === 0) {
      items.push({
        label: "pipelines",
        detail: `none in ${folderFor(repo)}`,
        state: "none",
      });
    }
    return { items, count };
  });

