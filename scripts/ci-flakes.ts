/**
 * The flake report: what failed in the last CI runs, and what only passed on a later attempt.
 *
 *   bun scripts/ci-flakes.ts                 # the last 25 CI runs
 *   bun scripts/ci-flakes.ts --limit=100     # a wider window
 *
 * Needs `gh`, logged in to the repository's host. The run list comes from the API; the test
 * results come from each run's log, because a test that passes on attempt 2 is green in the
 * conclusion and leaves no other trace. Bun's retry marker is the signal:
 *
 *   (pass) the dashboard fills the window … (attempt 2) [664.67ms]
 *
 * The parsing is exported and pinned in test/ciFlakes.test.ts, so a change in the log format
 * fails a test instead of quietly reporting no flakes.
 */
import { spawnSync } from "node:child_process";

export interface RunInfo {
  readonly id: number;
  readonly attempt: number;
  readonly conclusion: string;
  readonly createdAt: string;
  readonly branch: string;
  readonly title: string;
}

export interface LogEvent {
  readonly file: string;
  readonly name: string;
  readonly outcome: "pass" | "fail";
  readonly attempt: number;
}

export interface TestFlake {
  readonly file: string;
  readonly name: string;
  readonly count: number;
  readonly runIds: readonly number[];
}

export interface FlakeReport {
  readonly runs: readonly RunInfo[];
  readonly red: readonly RunInfo[];
  readonly rerun: readonly RunInfo[];
  readonly retried: readonly TestFlake[];
  readonly failed: readonly TestFlake[];
}

interface RawRun {
  readonly databaseId: number;
  readonly attempt: number;
  readonly conclusion: string;
  readonly createdAt: string;
  readonly headBranch: string;
  readonly displayTitle: string;
}

const TEST_LINE = /\(pass\) (.+?)(?: \(attempt (\d+)\))? \[[\d.]+m?s\]$/;
const FAILED_LINE = /\(fail\) (.+?)(?: \(attempt (\d+)\))? \[[\d.]+m?s\]$/;
const FILE_LINE = /((?:[\w.@-]+\/)*[\w.@-]+\.test\.ts):$/;

/** The `(pass)`/`(fail)` results in one run's log. A result is deduped by file, name, outcome and
 * attempt: Bun prints a failed test once where it ran and again in the run's summary. */
export const parseTestLog = (log: string): readonly LogEvent[] => {
  const events = new Map<string, LogEvent>();
  let file = "";
  // The run ends with a summary that repeats every final failure, after the last file's group.
  // Its lines carry that file's name, which would attribute each failure to the wrong file.
  let inSummary = false;
  for (const line of log.split("\n")) {
    if (/\d+ tests? failed:$/.test(line)) {
      inSummary = true;
      continue;
    }
    if (inSummary) continue;
    const fileMatch = FILE_LINE.exec(line);
    if (fileMatch !== null) {
      file = fileMatch[1]!;
      continue;
    }
    const passed = TEST_LINE.exec(line);
    const failed = FAILED_LINE.exec(line);
    const match = passed ?? failed;
    if (match === null) continue;
    const event: LogEvent = {
      file,
      name: match[1]!,
      outcome: passed === null ? "fail" : "pass",
      attempt: match[2] === undefined ? 1 : Number(match[2]),
    };
    events.set(`${event.file}\u0000${event.name}\u0000${event.outcome}\u0000${event.attempt}`, event);
  }
  return [...events.values()];
};

/** Group the attempts by test: a pass on a later attempt is a retried flake, and a fail is a red
 * one. A test can be both across runs, which is the useful signal. */
const group = (
  events: readonly { readonly event: LogEvent; readonly runId: number }[],
): readonly TestFlake[] => {
  const byTest = new Map<string, { file: string; name: string; runIds: number[] }>();
  for (const { event, runId } of events) {
    const key = `${event.file}\u0000${event.name}`;
    const entry = byTest.get(key) ?? { file: event.file, name: event.name, runIds: [] };
    if (!entry.runIds.includes(runId)) entry.runIds.push(runId);
    byTest.set(key, entry);
  }
  return [...byTest.values()]
    .map((entry) => ({ ...entry, count: entry.runIds.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export interface RunEvents {
  readonly run: RunInfo;
  readonly events: readonly LogEvent[];
}

export const summarize = (runEvents: readonly RunEvents[]): FlakeReport => {
  const retried = runEvents.flatMap(({ run, events }) =>
    events
      .filter((event) => event.outcome === "pass" && event.attempt > 1)
      .map((event) => ({ event, runId: run.id })),
  );
  // A test with a passing attempt in the same run recovered, even if the log also names the
  // attempt that failed; only a test with no pass at all is a final failure.
  const failed = runEvents.flatMap(({ run, events }) => {
    const passed = new Set(
      events.filter((event) => event.outcome === "pass").map((event) => `${event.file}\u0000${event.name}`),
    );
    return events
      .filter((event) => event.outcome === "fail" && !passed.has(`${event.file}\u0000${event.name}`))
      .map((event) => ({ event, runId: run.id }));
  });
  return {
    runs: runEvents.map(({ run }) => run),
    red: runEvents.filter(({ run }) => run.conclusion === "failure").map(({ run }) => run),
    rerun: runEvents.filter(({ run }) => run.attempt > 1).map(({ run }) => run),
    retried: group(retried),
    failed: group(failed),
  };
};

const usage = (): void => {
  console.log(
    [
      "usage: bun scripts/ci-flakes.ts [--limit=N]",
      "",
      "  --limit=N   how many CI runs to read (default 25)",
      "",
      "Needs `gh` in the repository's directory, logged in to the repository's host.",
    ].join("\n"),
  );
};

const option = (name: string): string | undefined => {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
};

const gh = (args: readonly string[]): string => {
  const result = spawnSync("gh", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) throw new Error(`gh: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr ?? "").trim() || "no output"}`);
  }
  return result.stdout;
};

const listRuns = (limit: number): readonly RunInfo[] => {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow=CI",
      `--limit=${limit}`,
      "--json",
      "databaseId,attempt,conclusion,createdAt,headBranch,displayTitle",
    ]),
  ) as RawRun[];
  return runs.map((run) => ({
    id: run.databaseId,
    attempt: run.attempt,
    conclusion: run.conclusion,
    createdAt: run.createdAt,
    branch: run.headBranch,
    title: run.displayTitle,
  }));
};

const runLog = (id: number): string => {
  // A run that is still going has no log to read yet; that is not an error.
  const result = spawnSync("gh", ["run", "view", String(id), "--log"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : "";
};

const printFlakes = (label: string, flakes: readonly TestFlake[]): void => {
  if (flakes.length === 0) return;
  console.log(`\n${label}`);
  for (const flake of flakes) {
    const runs = flake.runIds.map((id) => `#${id}`).join(", ");
    console.log(`  ${String(flake.count).padStart(2)}× ${flake.name} (${flake.file}) — ${runs}`);
  }
};

const printRuns = (label: string, runs: readonly RunInfo[]): void => {
  if (runs.length === 0) return;
  console.log(`\n${label}`);
  for (const run of runs) {
    const attempt = run.attempt > 1 ? ` attempt ${run.attempt}` : "";
    console.log(`  #${run.id} ${run.createdAt.slice(0, 10)} ${run.branch}${attempt} — ${run.title}`);
  }
};

const main = (): number => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return 0;
  }
  const limit = Number(option("--limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("--limit must be a positive whole number");
    return 2;
  }

  const runs = listRuns(limit);
  if (runs.length === 0) {
    console.log("no CI runs found");
    return 0;
  }
  const runEvents = runs.map((run) => ({ run, events: parseTestLog(runLog(run.id)) }));
  const report = summarize(runEvents);

  console.log(
    `${report.runs.length} CI runs — ${report.red.length} red, ${report.rerun.length} re-run, ` +
      `${report.retried.length} test(s) passed only on a later attempt`,
  );
  printRuns("RED RUNS", report.red);
  printRuns(
    "RE-RUN BY HAND",
    report.rerun.filter((run) => run.conclusion === "success"),
  );
  printFlakes("PASSED ON A LATER ATTEMPT", report.retried);
  printFlakes("FAILED OUTRIGHT", report.failed);
  return 0;
};

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
