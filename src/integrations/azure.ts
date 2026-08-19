import { basename } from "node:path";
import type { Change, WidgetItem, WidgetState } from "../types.ts";
import { sh, json } from "../sh.ts";
import { config } from "../config.ts";

type Run = {
  id: number;
  buildNumber: string;
  status: string;
  result?: string | null;
  sourceBranch: string;
  startTime?: string | null;
  finishTime?: string | null;
  definition?: { id?: number; name?: string };
};

type Definition = { id: number; name: string; path: string };

/** How many finished runs the duration estimate averages over. Branches differ, but the same
 * pipeline on the same agents is the best predictor available. */
const historySize = (): string => process.env.IWE_AZURE_HISTORY ?? "10";

/** Runs shown per pipeline. The newest is what you look at; the rest are history. */
const runsPerPipeline = (): number => Number(process.env.IWE_AZURE_RUNS ?? 3);

/** Organisation and project default to whatever `az devops configure` already holds, so the
 * Azure CLI stays the single place this is configured. */
let defaults: { organization?: string; project?: string } | null = null;

async function azDefaults(): Promise<{ organization?: string; project?: string }> {
  if (defaults) return defaults;
  const r = await sh(["az", "devops", "configure", "-l"]);
  const read = (key: string): string | undefined =>
    new RegExp(`^${key}\\s*=\\s*(\\S+)`, "m").exec(r.stdout)?.[1];
  defaults = {
    organization: config.azureOrganization || read("organization"),
    project: config.azureProject || read("project"),
  };
  return defaults;
}

/** A queued or running build is pending; anything but success is a problem worth a red dot. */
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
  pr ? [`refs/pull/${pr}/merge`, `refs/heads/${branch}`] : [`refs/heads/${branch}`];

/** Azure DevOps pipeline folders mirror the service directories of a monorepo (`\service-x`),
 * which is how runs are attributed to a repository: `repository.name` comes back null. */
export const folderFor = (repo: string): string => `\\${basename(repo)}`;

async function listDefinitions(repo: string): Promise<Definition[]> {
  const r = await sh(["az", "pipelines", "list", "--folder-path", folderFor(repo), "-o", "json"]);
  return r.code === 0 ? json<Definition[]>(r.stdout, []) : [];
}

async function runsFor(refs: string[]): Promise<{ runs: Run[]; error?: string }> {
  // One query per ref; grouping per pipeline happens here rather than in a query per pipeline.
  const results = await Promise.all(
    refs.map((ref) =>
      sh(["az", "pipelines", "runs", "list", "--branch", ref, "--top", "50", "-o", "json"]),
    ),
  );
  const failed = results.find((r) => r.code !== 0);
  if (failed) return { runs: [], error: (failed.stderr || failed.stdout).split("\n")[0] };
  const byId = new Map<number, Run>();
  for (const r of results) for (const run of json<Run[]>(r.stdout, [])) byId.set(run.id, run);
  // Newest first, so slicing per pipeline keeps the most recent runs.
  return { runs: [...byId.values()].sort((a, b) => b.id - a.id) };
}

/** Mean duration of the last finished runs of a pipeline, across branches. */
export function averageDuration(runs: Run[]): number | undefined {
  const durations = runs
    .map((r) =>
      r.startTime && r.finishTime
        ? new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()
        : 0,
    )
    .filter((ms) => ms > 0);
  if (durations.length === 0) return undefined;
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

async function expectedDuration(definitionId: number): Promise<number | undefined> {
  const r = await sh([
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
  return r.code === 0 ? averageDuration(json<Run[]>(r.stdout, [])) : undefined;
}

/** The artifact version a build produced, as printed by the pipelines themselves. Ported from
 * example-legacy-misc/scripts/version-from-pr. */
const VERSION_PATTERNS = [
  /Version is: '([^']+)'/,
  // Deliberately looser than the source script: docker prints the tag after a full image
  // reference ("pushing manifest for registry/app:20260818.4"), which its \b anchor missed.
  /pushing manifest for \S*?([0-9]{8}\.\d+)\b/,
  /Built and pushed image as .*:([0-9]{8}\.\d+)\b/,
];

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
async function logIds(project: string, pipelineId: number, runId: number): Promise<number[]> {
  const r = await sh([
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
  return json<{ logs?: { id: number }[] }>(r.stdout, {}).logs?.map((l) => l.id) ?? [];
}

async function logLines(project: string, runId: number, logId: number): Promise<string[]> {
  const r = await sh([
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
  return r.code === 0 ? (json<{ value?: string[] }>(r.stdout, {}).value ?? []) : [];
}

/** A finished run's logs never change, so a version is looked up once and kept. */
const versions = new Map<number, string | undefined>();

async function versionOf(run: Run, project: string): Promise<string | undefined> {
  // Only successful builds produced an artifact worth naming.
  if (run.status !== "completed" || run.result !== "succeeded") return undefined;
  if (versions.has(run.id)) return versions.get(run.id);

  const pipelineId = run.definition?.id;
  const version = pipelineId ? await findVersion(project, pipelineId, run.id) : undefined;
  versions.set(run.id, version);
  return version;
}

async function findVersion(
  project: string,
  pipelineId: number,
  runId: number,
): Promise<string | undefined> {
  // Publishing happens at the end of a build, so the last steps are searched first: in practice
  // the version turns up in the first batch. ponytail: batches of 5, widen if it ever drags.
  const ids = (await logIds(project, pipelineId, runId)).sort((a, b) => b - a);
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(
      ids.slice(i, i + 5).map(async (id) => versionInLines(await logLines(project, runId, id))),
    );
    const found = batch.find(Boolean);
    if (found) return found;
  }
  return undefined;
}

const worst = (states: WidgetState[]): WidgetState =>
  states.includes("error")
    ? "error"
    : states.includes("pending")
      ? "pending"
      : states.includes("warn")
        ? "warn"
        : states.includes("ok")
          ? "ok"
          : "none";

/** One row per pipeline of this repository, with its runs for this ref as children. */
export async function pipelineItems(
  change: Change,
  repo: string,
  pr?: number,
): Promise<{ items: WidgetItem[]; count: number }> {
  const refs = refsFor(change.branch, pr);
  const [definitions, { runs, error }] = await Promise.all([listDefinitions(repo), runsFor(refs)]);
  if (error) return { items: [{ label: "pipelines", detail: error, state: "error" }], count: 0 };

  const { organization, project } = await azDefaults();
  const url = (id: number): string | undefined =>
    organization && project
      ? `${organization}/${encodeURIComponent(project)}/_build/results?buildId=${id}`
      : undefined;

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
    (byDefinition.get(d.id) ?? []).some((run) => run.status !== "completed"),
  );
  const expected = new Map(
    await Promise.all(
      running.map(async (d): Promise<[number, number | undefined]> => [
        d.id,
        await expectedDuration(d.id),
      ]),
    ),
  );

  const items = await Promise.all(definitions.map(async (definition): Promise<WidgetItem> => {
    const mine = (byDefinition.get(definition.id) ?? []).slice(0, runsPerPipeline());
    count += mine.length;
    const children = mine.map((run): WidgetItem => {
      const done = run.status === "completed";
      return {
        label: run.buildNumber,
        detail: done ? (run.result ?? "completed") : run.status,
        url: url(run.id),
        state: runState(run),
        progress:
          !done && run.startTime
            ? { startedAt: run.startTime, expectedMs: expected.get(definition.id) }
            : undefined,
      };
    });
    // The version each successful build produced, read from its logs.
    if (project) {
      await Promise.all(
        mine.map(async (run, index) => {
          const version = await versionOf(run, project);
          const child = children[index]!;
          if (version) child.detail = [child.detail, version].filter(Boolean).join(" · ");
        }),
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
  }));

  if (items.length === 0) {
    items.push({ label: "pipelines", detail: `none in ${folderFor(repo)}`, state: "none" });
  }
  return { items, count };
}
