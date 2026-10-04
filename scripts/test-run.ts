/**
 * The test suite's runner: a run token, isolated roots, a cleanup trap, then `bun test`.
 *
 *   bun scripts/test-run.ts               # the unit files across workers, then the browser files one by one
 *   bun scripts/test-run.ts unit          # everything but the browser end-to-end files
 *   bun scripts/test-run.ts e2e           # the browser end-to-end files, one at a time
 *   bun scripts/test-run.ts e2e-terminal  # the browser files named test/terminal*.test.ts
 *   bun scripts/test-run.ts e2e-rest      # every other browser end-to-end file
 *   bun scripts/test-run.ts --list <mode> # that mode's files, one per line, without running anything
 *
 * Any further arguments go to `bun test` (`--retry=2`, a file filter, …).
 *
 * A named mode whose group matched no test files exits 3 with a message on stderr; it never falls
 * through to `bun test` with an empty argument list, which would run the whole suite instead.
 *
 * The terminal group is a naming convention, not a semantic one: browser files that merely drive
 * terminal UI stay in the rest group.
 *
 * The token names everything the run makes — temp dirs, servers, hosts — so
 * scripts/clean-test.ts can end a crashed run's leftovers without ever touching a suite in
 * progress (its own documentation is the full story). Cleanup runs exactly once, whatever ends
 * the process: a normal exit, a failure, SIGINT or SIGTERM.
 *
 * Discovery and classification are pure functions shared with test/test-run.test.ts, so the rule
 * has one home and the test pins the partition rather than restating it.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export type Mode = "all" | "unit" | "e2e" | "e2e-terminal" | "e2e-rest";
export type Group = "unit" | "e2e-terminal" | "e2e-rest";

/** The discovered files, grouped. `e2e` is the two browser groups in the order the runner runs
 * them (terminal then rest), so a mode list is also its run order. */
export interface Groups {
  readonly unit: readonly string[];
  readonly e2eTerminal: readonly string[];
  readonly e2eRest: readonly string[];
  readonly e2e: readonly string[];
}

const MODES: readonly Mode[] = ["all", "unit", "e2e", "e2e-terminal", "e2e-rest"];

/** A Corvi pane exports its own identity and log path; the suite must be hermetic whether it is
 * launched from a pane or a plain shell. Each test sets the roots and identities it needs. */
const SCRUBBED = [
  "CORVI_LOG",
  "CORVI_SESSION_ID",
  "CORVI_SESSION_INCARNATION",
  "CORVI_CHANGE_ID",
  "CORVI_CHANGE_DIR",
  "CORVI_SUBAGENT_ID",
] as const;

/** The browser end-to-end files import a Playwright browser at runtime. The test is
 * line-oriented because the shell `grep` this replaces was: a multi-line import (or a type-only
 * one, whose braces name no browser) is not a browser file. */
const PLAYWRIGHT_IMPORT =
  /^[ \t]*import[ \t]+\{[^}]*(chromium|webkit|firefox)[^}]*\}[ \t]*from[ \t]*"playwright"/;

export const importsBrowserAtRuntime = (source: string): boolean =>
  source.split("\n").some((line) => PLAYWRIGHT_IMPORT.test(line));

/** The terminal group is a name, not a claim about what the test drives. `.*` spans separators
 * like the shell glob `test/terminal*.test.ts` it replaces. */
export const isTerminalGroup = (file: string): boolean => /^test\/terminal.*\.test\.ts$/.test(file);

export const classify = (file: string, source: string): Group =>
  importsBrowserAtRuntime(source) ? (isTerminalGroup(file) ? "e2e-terminal" : "e2e-rest") : "unit";

/** Walk `**\/*.test.ts` under `root`, skipping every `node_modules` — the shell discovery this
 * replaces skipped only the root one; pruning them all is strictly safer. Return repo-relative
 * POSIX paths, sorted. Symlinked directories are not followed. */
const collectTestFiles = (dir: string, root: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") collectTestFiles(join(dir, entry.name), root, out);
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
    }
  }
};

export const discoverTestFiles = (root: string = process.cwd()): readonly string[] => {
  const files: string[] = [];
  collectTestFiles(root, root, files);
  return files.sort();
};

export const discoverGroups = (root: string = process.cwd()): Groups => {
  const unit: string[] = [];
  const e2eTerminal: string[] = [];
  const e2eRest: string[] = [];
  for (const file of discoverTestFiles(root)) {
    switch (classify(file, readFileSync(join(root, file), "utf8"))) {
      case "unit":
        unit.push(file);
        break;
      case "e2e-terminal":
        e2eTerminal.push(file);
        break;
      case "e2e-rest":
        e2eRest.push(file);
        break;
    }
  }
  return { unit, e2eTerminal, e2eRest, e2e: [...e2eTerminal, ...e2eRest] };
};

export const isMode = (value: string | undefined): value is Mode =>
  value !== undefined && (MODES as readonly string[]).includes(value);

export const filesForMode = (mode: Mode, groups: Groups): readonly string[] => {
  switch (mode) {
    case "all":
      return [...groups.unit, ...groups.e2e];
    case "unit":
      return groups.unit;
    case "e2e":
      return groups.e2e;
    case "e2e-terminal":
      return groups.e2eTerminal;
    case "e2e-rest":
      return groups.e2eRest;
  }
};

const USAGE =
  "usage: scripts/test-run.ts [all|unit|e2e|e2e-terminal|e2e-rest] [bun test arguments...]";

/** `bun test --timeout 30000 [--parallel] --timings=scripts/timings.json <files> <args>`.
 * `--parallel` is omitted for the e2e modes (they contend for one machine) and when
 * `CORVI_TEST_SERIAL=1` forces a single process, where a stalled teardown cannot hang the run. */
const testArgs = (
  files: readonly string[],
  passthrough: readonly string[],
  parallel: boolean,
): string[] => [
  "bun",
  "test",
  "--timeout",
  "30000",
  ...(parallel && process.env.CORVI_TEST_SERIAL !== "1" ? ["--parallel"] : []),
  "--timings=scripts/timings.json",
  ...files,
  ...passthrough,
];

/** The child currently running, for the signal handler to forward to and reap. */
let runningChild: ReturnType<typeof Bun.spawn> | undefined;

/** Set once a signal owns the shutdown, so the main flow parks instead of starting another child. */
let terminating = false;

/** Run a child with inherited stdio and resolve its exit code. `env` is passed explicitly:
 * `Bun.spawn` otherwise snapshots the environment as it was when Bun launched. */
const spawnRun = async (cmd: readonly string[]): Promise<number> => {
  const child = Bun.spawn([...cmd], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  runningChild = child;
  try {
    return await child.exited;
  } finally {
    if (runningChild === child) runningChild = undefined;
  }
};

/** Once a signal owns the shutdown, the main flow must not spawn another child: park it so the
 * signal handler's exit (with the reaped child's code) is the one that lands. */
const stopIfTerminating = async (): Promise<void> => {
  if (terminating) await new Promise<never>(() => {});
};

const runTests = (
  files: readonly string[],
  passthrough: readonly string[],
  parallel: boolean,
): Promise<number> => spawnRun(testArgs(files, passthrough, parallel));

const SIGNAL_EXIT_CODES: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
];

/** How long to wait for a signaled child to exit before cleaning up without it. */
const SIGNAL_REAP_MS = 10_000;

const withTimeout = async (
  promise: Promise<number | undefined>,
  ms: number,
): Promise<number | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Cleanup is synchronous (`Bun.spawnSync`), so it still runs from the `exit` handler however the
 * process ends. The flag keeps it exactly once. A cleanup failure is swallowed: it must not
 * replace the run's own exit code. */
const installCleanup = (token: string): void => {
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      Bun.spawnSync(["bun", "scripts/clean-test.ts", "--kill", "--prune", `--run=${token}`], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });
    } catch {
      // A cleanup failure must not replace the run's own exit code.
    }
  };
  process.on("exit", cleanup);

  // A signal mirrors the shell's `status=$?; cleanup; exit $status`: forward it to the running
  // child, wait (bounded) for it to exit, then exit with the child's own code. Cleanup happens in
  // the exit handler, after the child is gone, not under its teardown.
  for (const [signal, fallback] of SIGNAL_EXIT_CODES) {
    process.on(signal, () => {
      if (terminating) {
        // A second signal is a force quit; cleanup still runs from the exit handler.
        process.exit(fallback);
        return;
      }
      terminating = true;
      void (async () => {
        const child = runningChild;
        if (child === undefined) {
          process.exit(fallback);
          return;
        }
        try {
          child.kill(signal);
        } catch {
          // The child exited between the signal and the forward.
        }
        // `.catch` keeps the exit unconditional: a rejected `exited` must not leave the parked
        // main flow hanging instead of cleaning up and exiting.
        const exitCode = await withTimeout(child.exited.catch(() => undefined), SIGNAL_REAP_MS);
        process.exit(exitCode ?? fallback);
      })();
    });
  }
};

const list = (requested: string | undefined): number => {
  if (!isMode(requested)) {
    console.error(USAGE);
    return 2;
  }
  for (const file of filesForMode(requested, discoverGroups())) console.log(file);
  return 0;
};

const runMode = async (
  mode: Mode,
  groups: Groups,
  passthrough: readonly string[],
): Promise<number> => {
  switch (mode) {
    case "unit":
      return runTests(groups.unit, passthrough, true);
    case "e2e":
      return runTests(groups.e2e, passthrough, false);
    case "e2e-terminal":
      return runTests(groups.e2eTerminal, passthrough, false);
    case "e2e-rest":
      return runTests(groups.e2eRest, passthrough, false);
    case "all": {
      // A pass-through argument is a filter or a flag, and the caller asked for one discovery
      // pass, so it runs unfiltered by group and with no file list (`bun test` discovers).
      if (passthrough.length > 0) return runTests([], passthrough, true);
      if (groups.unit.length > 0) {
        const unitCode = await runTests(groups.unit, [], true);
        await stopIfTerminating();
        if (unitCode !== 0) {
          // Silently never running the browser files reads as a green suite that omitted them.
          console.error("the browser shard is skipped: the unit shard failed");
          return 1;
        }
      }
      if (groups.e2e.length > 0) return runTests(groups.e2e, [], false);
      return 0;
    }
  }
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);

  if (args[0] === "--list") return list(args[1]);

  const mode = args[0] ?? "all";
  if (!isMode(mode)) {
    console.error(USAGE);
    return 2;
  }
  const passthrough = args.slice(1);

  for (const name of SCRUBBED) delete process.env[name];

  const token = process.env.CORVI_TEST_RUN || `${Math.floor(Date.now() / 1000)}.${process.pid}`;
  process.env.CORVI_TEST_RUN = token;
  const tmp = tmpdir();
  writeFileSync(join(tmp, `corvi-${token}.pid`), String(process.pid));
  const root = mkdtempSync(join(tmp, `corvi-${token}-root-`));
  process.env.CORVI_ROOT = root;
  process.env.CORVI_ARCHIVE_ROOT = `${root}-archive`;
  process.env.CORVI_CONFIG = join(root, "config.json");
  process.env.XDG_STATE_HOME = join(root, "state");

  installCleanup(token);

  const groups = discoverGroups();

  // The guard runs before `build:web` so a doomed invocation does not pay for a web build. `all`
  // composes whatever was found and stays unguarded.
  if (mode !== "all" && filesForMode(mode, groups).length === 0) {
    console.error(`scripts/test-run.ts: the ${mode} group matched no test files`);
    return 3;
  }

  const buildCode = await spawnRun(["bun", "run", "build:web"]);
  await stopIfTerminating();
  if (buildCode !== 0) return buildCode;

  return runMode(mode, groups, passthrough);
};

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(code);
}
