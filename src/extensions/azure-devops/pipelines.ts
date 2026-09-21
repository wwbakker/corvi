import { basename } from "node:path";
import { Effect, Schema } from "effect";
import type { WidgetItem, WidgetState } from "../../domain/widget.ts";
import { Cache, Changes, Settings, Shell, Workspace } from "../../integrations/api/capabilities.ts";
import { cliJson } from "../../capabilities/effect/support.ts";
import { env } from "../../capabilities/identity.ts";
import type { Result } from "../../capabilities/shell.ts";
import { azFor, type Az } from "./azure.ts";

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
const historySize = (): string => process.env[env("AZURE_HISTORY")] ?? "10";

/** Runs shown per pipeline. The newest is what you look at; the rest are history. */
const runsPerPipeline = (): number => Number(process.env[env("AZURE_RUNS")] ?? 3);

/** The environment variables the extension's declared settings name, so the settings page's
 * lock and the settings read cannot drift apart. */
export const AZURE_HISTORY_ENV = env("AZURE_HISTORY");
export const AZURE_RUNS_ENV = env("AZURE_RUNS");

/** The Result-branching contract: the one failure `Shell` can raise here is a timeout, which
 * surfaces as a failed command (exit code 124) rather than a failure of the operation, so
 * everything downstream branches on `code`. */
const shResult = (cmd: string[]): Effect.Effect<Result, never, Shell | Workspace> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    return yield* shell.run(cmd).pipe(
      Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
    );
  });

const cached = <A>(
  key: string,
  ttlMs: number,
  work: Effect.Effect<A, never, Shell | Workspace | Cache>,
): Effect.Effect<A, never, Shell | Workspace | Cache> =>
  Effect.flatMap(Cache, (cache) => cache.swr(key, ttlMs, work));

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
 * sharing and the staleness both live in the contract's `Cache` capability.
 */

/** Pipelines are moved between folders about never; runs happen while you watch. Both are
 * served from the cache while the refresh runs, so neither number is ever waited for twice. */
const DEFINITIONS_TTL = 5 * 60_000;
const RUNS_TTL = 10_000;

const listDefinitions = (
  az: Az,
  repo: string,
): Effect.Effect<Definition[], never, Shell | Workspace | Cache> =>
  cached(
    `az:${az.key}:definitions:${folderFor(repo)}`,
    DEFINITIONS_TTL,
    Effect.gen(function* () {
      const r = yield* shResult([
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
    }),
  );

const runsFor = (
  az: Az,
  refs: string[],
): Effect.Effect<{ runs: Run[]; error?: string }, never, Shell | Workspace | Cache> =>
  Effect.gen(function* () {
    // One query per ref; grouping per pipeline happens here rather than in a query per pipeline.
    // The branch ref is the same for every repository of a change, so this is asked six times at
    // once and answered once.
    const results = yield* Effect.all(
      refs.map((ref) =>
        cached(
          `az:${az.key}:runs:${ref}`,
          RUNS_TTL,
          shResult([
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
          ]),
        )
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
export const activeRuns = (
  change: { branch: string; workspace?: string },
  repo: string,
  pr?: number,
): Effect.Effect<number, never, Shell | Workspace | Cache | Settings> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
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

export const expectedDuration = (
  az: Az,
  definitionId: number,
): Effect.Effect<number | undefined, never, Shell | Workspace | Cache> =>
  cached(
    `az:${az.key}:duration:${definitionId}`,
    DEFINITIONS_TTL,
    Effect.gen(function* () {
      const r = yield* shResult([
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
    }),
  );

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
const logIds = (
  project: string,
  pipelineId: number,
  runId: number,
): Effect.Effect<number[], never, Shell | Workspace> =>
  Effect.gen(function* () {
    const r = yield* shResult([
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

const logLines = (
  project: string,
  runId: number,
  logId: number,
): Effect.Effect<string[], never, Shell | Workspace> =>
  Effect.gen(function* () {
    const r = yield* shResult([
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

/** A finished run's logs never change, so a version is looked up once and kept — in the
 * shared cache, under the run id, rather than a module-local memo: the answer is a pure
 * function of the run, and the cache's single-flight refresh already shares it. Tests reset
 * it with `clearCache`, like every other cached answer. */
export const versionOf = (
  run: Run,
  project: string,
): Effect.Effect<string | undefined, never, Shell | Workspace | Cache> =>
  Effect.suspend(() => {
    // Only successful builds produced an artifact worth naming.
    if (run.status !== "completed" || run.result !== "succeeded") return Effect.succeed(undefined);
    const pipelineId = run.definition?.id;
    if (pipelineId === undefined) return Effect.succeed(undefined);
    return Effect.flatMap(Cache, (cache) =>
      cache.swr(`az:version:${run.id}`, 24 * 60 * 60_000, findVersion(project, pipelineId, run.id)),
    );
  });

const findVersion = (
  project: string,
  pipelineId: number,
  runId: number,
): Effect.Effect<string | undefined, never, Shell | Workspace> =>
  Effect.gen(function* () {
    // Publishing happens at the end of a build, so the last steps are searched first: in practice
    // the version turns up in the first batch.
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
export function buildUrl(id: number, az: Az): string | undefined {
  const { organization, project } = az;
  return organization && project
    ? `${organization}/${encodeURIComponent(project)}/_build/results?buildId=${id}`
    : undefined;
}

// Pure and synchronous: nothing for an Effect to wrap.

/** One row per pipeline of this repository, with its runs for this ref as children. An empty
 * answer is no row at all rather than a row saying so: a repository built by GitHub Actions, or
 * by pipelines in another project, has nothing here to show. */
export const pipelineItems = (
  change: { branch: string; workspace?: string },
  repo: string,
  pr?: number,
): Effect.Effect<{ items: WidgetItem[]; count: number }, never, Shell | Workspace | Cache | Settings> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
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

    return { items, count };
  });

