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

/** Pipelines are triggered by the PR merge ref once a PR exists, and by the branch before that. */
export const refFor = (branch: string, pr?: number): string =>
  pr ? `refs/pull/${pr}/merge` : `refs/heads/${branch}`;

/** Azure DevOps pipeline folders mirror the service directories of a monorepo (`\service-x`),
 * which is how runs are attributed to a repository: `repository.name` comes back null. */
export const folderFor = (repo: string): string => `\\${basename(repo)}`;

async function listDefinitions(repo: string): Promise<Definition[]> {
  const r = await sh(["az", "pipelines", "list", "--folder-path", folderFor(repo), "-o", "json"]);
  return r.code === 0 ? json<Definition[]>(r.stdout, []) : [];
}

async function runsFor(ref: string): Promise<{ runs: Run[]; error?: string }> {
  // One query for the ref; grouping per pipeline happens here rather than in N queries.
  const r = await sh([
    "az",
    "pipelines",
    "runs",
    "list",
    "--branch",
    ref,
    "--top",
    "50",
    "-o",
    "json",
  ]);
  if (r.code !== 0) return { runs: [], error: (r.stderr || r.stdout).split("\n")[0] };
  return { runs: json<Run[]>(r.stdout, []) };
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
  const ref = refFor(change.branch, pr);
  const [definitions, { runs, error }] = await Promise.all([listDefinitions(repo), runsFor(ref)]);
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

  const items = definitions.map((definition): WidgetItem => {
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
    return {
      label: definition.name,
      // Runs speak for themselves when listed; their absence does not.
      detail: children.length ? undefined : "no runs for this branch",
      state: children.length ? worst(children.map((c) => c.state ?? "none")) : "none",
      children,
    };
  });

  if (items.length === 0) {
    items.push({ label: "pipelines", detail: `none in ${folderFor(repo)}`, state: "none" });
  }
  return { items, count };
}
