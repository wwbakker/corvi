/**
 * Ends what test runs left running, and nothing else.
 *
 *   bun run test:clean                  # list every test-owned process, and whose run it is
 *   bun run test:clean --kill           # end the leavings of runs that are gone
 *   bun run test:clean --kill --run=T   # end exactly run T (what a run's EXIT trap does)
 *   bun run test:clean --kill --all     # end every test-owned process (the escape hatch)
 *   bun run test:clean --prune          # ...and remove paths (only with --run=T or --all)
 *   bun run test:clean --verbose        # also say so when there is nothing
 *
 * Tests start real things — servers and terminal hosts on Node — and an aborted run leaves them
 * behind. Killing those by port or by process name is how a live Corvi.app server was once
 * destroyed: from the outside they look exactly like test leftovers. So ownership here is
 * decided only by things a test's processes carry and the app's never do: a server is a test's
 * when its command line carries `--corvi-test-run`, which the tests pass and
 * apps/server/src/server.ts ignores. The app's server (`electron apps/server/src/server.ts`) and
 * a dev server (`node apps/server/src/server.ts`) carry no marker.
 *
 * The prefix is the whole rule: an entry under `$TMPDIR` named `corvi-*` belongs to whoever it
 * names. Only explicit intent removes paths: `--run=<token>` removes exactly that run's entries,
 * `--all` removes every entry including unnamed ones, and the default leaks rather than guess
 * whose anything is. Do not name your own scratch files `corvi-…` there — a
 * `/tmp/corvi-notes.log` reads as a run named `notes.log`.
 *
 * Which run, and whether that run is still alive, is the second question — the one that lets two
 * suites run at once. A run is named by a token, a `<base36>.<base36>` pair the dot keeps apart
 * from the human labels a temp dir also carries. Its resources carry the token too:
 *
 *   - the server in `--corvi-test-run=<token>`;
 *   - and the run itself in `<tmpdir>/corvi-<token>.pid`, written by `testRun()` (test/helpers.ts)
 *     and holding its pid for as long as it lives.
 *
 * So the default `--kill` trusts one pid-file per run and ends the processes of runs it reads as
 * gone — including a run whose file names a worker that finished before `--parallel` did. That
 * stale-file case can end a live run's servers, so the process verdict is a guess too, not a
 * safety proof. A run's own EXIT trap passes `--run=<token>` to end exactly its own — and exactly
 * means exactly: with suites able to run side by side, that trap takes nothing that does not
 * carry its token (coversRun below). `--all` ends every test-owned process.
 *
 * Process liveness keeps that pid-file guess; path removal does not. The same guess once pruned a
 * live run's fixtures, so only explicit `--run=<token>` and `--all` remove paths, and the default
 * leaks them. Getting a misread run's processes ended stays a residual risk; deleting a live
 * run's directories does not.
 */
import { readFileSync } from "node:fs";
import { readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./sh.ts";

/** The roots a test directory can hide under: `tmpdir()` as written and as resolved. On macOS
 * `/var/folders/...` is a symlink into `/private/var/folders/...`, and both spellings turn up in
 * command lines depending on who built the path. */
export const testRoots = async (): Promise<string[]> => {
  const written = tmpdir();
  const resolved = await realpath(written).catch(() => written);
  return [...new Set([written, resolved])];
};

/** Collapse duplicate slashes before comparing: macOS's TMPDIR ends in a slash, so a shell-built
 * `$TMPDIR/corvi-x` is `/var/folders/.../T//corvi-x` and would not match the `T/corvi-` prefix. */
const normalize = (path: string): string => path.replace(/\/{2,}/g, "/");

/** Whether a command line belongs to a test run: only the marker every test server carries.
 * Pure and exported, so test/clean.test.ts can pin the shapes this must never confuse: a test's
 * server, the app's (`electron apps/server/src/server.ts`), and a dev server (`node apps/server/src/server.ts`). */
export const isTestCommand = (command: string): boolean => command.includes("--corvi-test-run");

/** A run token: two base36 words joined by a dot. The dot is what makes it recognisable in a
 * path that also carries a human label, and what keeps `corvi-term-abc` (label `term`) from being
 * read as run `term`. */
const TOKEN = "[0-9a-z]+\\.[0-9a-z]+";

/** Whether a string is a run token in full. The parsers below match a token as a prefix, because
 * they read it out of a longer path or command line; test/helpers.ts refuses a hand-set
 * `CORVI_TEST_RUN` that is not one, since the cleaner would otherwise leave that run's servers
 * behind as unattributable. */
export const isRunToken = (value: string): boolean => new RegExp(`^${TOKEN}$`).test(value);

/** The token a test process carries, or undefined: a resource with no token is one this tool
 * cannot attribute to a run (the app's dev server, or a leftover from before tokens), and is
 * left alone unless `--all`. The lookahead keeps a longer word from being read as a shorter
 * token: `--corvi-test-run=abc.defG` is not run `abc.def`. */
export const tokenOf = (command: string): string | undefined =>
  new RegExp(`--corvi-test-run=(${TOKEN})(?=\\s|$)`).exec(command)?.[1];

/** The token a path carries, or undefined: a resource with no token is one this tool cannot
 * attribute to a run (the app's, or a leftover from before tokens), and is left alone unless
 * `--all`. */
export const tokenFromPath = (path: string): string | undefined =>
  new RegExp(`(?:^|[\\\\/])corvi-(${TOKEN})(?=[-/]|$)`).exec(normalize(path))?.[1];

/** The token a pid-file name carries (`corvi-<token>.pid`), for pruning. Pure and exported, so
 * test/clean.test.ts can pin that only this parser reads a pid-file's token (tokenFromPath
 * requires the token be followed by `-` or `/`, which a `.pid` name is not). */
export const tokenFromPidFile = (name: string): string | undefined =>
  new RegExp(`^corvi-(${TOKEN})\\.pid$`).exec(name)?.[1];

/** Where a run writes its liveness: `<tmpdir>/corvi-<token>.pid`. The token names all of a run's
 * temp dirs, so one file answers for all of them. */
export const runPidPath = (root: string, token: string): string => join(root, `corvi-${token}.pid`);

type Proc = { pid: number; command: string };

const processes = async (): Promise<Proc[]> => {
  const { stdout } = await sh(["ps", "-Aww", "-o", "pid=,command="]);
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), command: match[2]! }));
};

/** Whether a run is still alive: its pid-file names a live process. A missing file, a malformed
 * one, or a dead pid all mean the run is gone. */
const liveToken = (token: string, roots: readonly string[]): boolean => {
  for (const root of roots) {
    try {
      const pid = Number(readFileSync(runPidPath(root, token), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return true;
    } catch {
      // no pid-file under this spelling of the root
    }
  }
  return false;
};

/** The only processes this tool is ever allowed to end: the runtimes a test server can be. */
const isKillable = (command: string): boolean =>
  /(?:^|\/)(?:bun|node)(?: |$).*src\/server\.ts/.test(command);

/** What the report lists as left alone: the things this tool could plausibly have ended and did
 * not — a server. */
const looksLikeApp = (command: string): boolean =>
  /(?:^|\/)(?:bun|node)(?: |$).*src\/server\.ts/.test(command);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** What a purge covers, by run. Only explicit intent removes paths: `--all` is every run's, and
 * `--run=<token>` is exactly that run's — the wrapper's exit trap names its own run to clean up
 * after itself. The default covers nothing: a run's liveness is read from a single pid-file, and
 * that guess has pruned a live neighbour's fixtures mid-test, so the default leaks instead. */
export const coversRun = (
  mode: { readonly all: boolean; readonly run: string | undefined },
  token: string,
): boolean => mode.all || mode.run === token;

/** What a purge covers for a path no run names. `--all` takes everything; the default and
 * `--run` take nothing — an unnamed entry may belong to a live suite, and only the explicit
 * `--all` may speak for it. */
export const coversUnnamed = (mode: { readonly all: boolean; readonly run: string | undefined }): boolean =>
  mode.all;

/** Whether a purge may remove paths at all. This is the single gate: `coversRun`/`coversUnnamed`
 * only choose among the explicit modes once it has opened. Only explicit intent does: `--all` is
 * the escape hatch and `--run=<token>` is exact. The default removes nothing — it still ends
 * orphaned processes, but a pid-file is a guess and that guess deleted a live neighbour's
 * fixtures, so it leaks instead (in tmpfs a leftover costs nothing, and a reboot clears it). */
export const mayRemovePaths = (mode: { readonly all: boolean; readonly run: string | undefined }): boolean =>
  mode.all || mode.run !== undefined;

/** Remove the temp dirs and pid-files of the runs a purge covers. */
const pruneLeftovers = async (
  roots: readonly string[],
  covers: (token: string) => boolean,
  removeUnnamed: boolean,
): Promise<string[]> => {
  const removed: string[] = [];
  const unique = [...new Set(await Promise.all(roots.map((root) => realpath(root).catch(() => root))))];
  for (const root of unique) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.name.startsWith("corvi-")) continue;
      const path = join(root, entry.name);
      const token = tokenFromPath(entry.name) ?? tokenFromPidFile(entry.name);
      if (token === undefined ? !removeUnnamed : !covers(token)) continue;
      await rm(path, { recursive: true, force: true }).then(
        () => removed.push(path),
        () => undefined, // something else is holding it; next time
      );
    }
  }
  return removed;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const has = (name: string): boolean => args.includes(`--${name}`);
  const kill = has("kill") || has("prune");
  const prune = has("prune");
  const all = has("all");
  const verbose = has("verbose");
  const run = args.find((a) => a.startsWith("--run="))?.slice("--run=".length);
  if (all && run !== undefined) {
    console.error("--all and --run= are alternatives: --all ignores whose run it is");
    process.exit(1);
  }

  const roots = await testRoots();
  const procs = (await processes()).filter((p) => isKillable(p.command) && isTestCommand(p.command));

  /** How a resource is judged: `chosen` (ended, or listed as such), `live` (a suite in progress),
   * or `unnamed` (a test-owned resource with no run token: an old run, or the app's). */
  const verdict = (token: string | undefined): "chosen" | "live" | "unnamed" => {
    if (all) return "chosen";
    if (run !== undefined) return token === run ? "chosen" : "unnamed";
    if (token === undefined) return "unnamed";
    return liveToken(token, roots) ? "live" : "chosen";
  };

  const note = (token: string | undefined): string => {
    const state = verdict(token);
    if (token === undefined) return "[no run — only --all ends this]";
    return state === "live" ? `[run ${token}, alive]` : `[run ${token}, gone]`;
  };

  const chosenProcs = procs.filter((p) => verdict(tokenOf(p.command)) === "chosen");

  /** Remove the paths a purge covers, or say why it left them. Only an explicit mode removes
   * anything: the default ends processes but leaks their paths rather than guess (mayRemovePaths). */
  const prunePaths = async (): Promise<void> => {
    if (!mayRemovePaths({ all, run })) {
      console.log("the default purge removes no paths; pass --run=<token> or --all to remove them");
      return;
    }
    const removed = await pruneLeftovers(
      roots,
      (t) => coversRun({ all, run }, t),
      coversUnnamed({ all, run }),
    );
    if (removed.length) console.log(`removed ${removed.length} leftover test path(s):\n  ${removed.join("\n  ")}`);
  };

  if (!procs.length) {
    if (verbose) console.log("no test processes are running");
    if (prune) await prunePaths();
    return;
  }

  console.log(
    `${kill ? "ending" : "found"} ${chosenProcs.length} test process(es)` +
      (all ? " (--all)" : run !== undefined ? ` (run ${run})` : " of runs that are gone") +
      ` — ${procs.length} test-owned in all:`,
  );
  for (const p of procs) console.log(`  ${p.pid} ${p.command.slice(0, 120)} ${note(tokenOf(p.command))}`);
  const untouched = (await processes()).filter((p) => looksLikeApp(p.command) && !isTestCommand(p.command));
  if (untouched.length) {
    console.log(`${untouched.length} server/terminal process(es) left alone (not test-owned):`);
    for (const p of untouched) console.log(`  ${p.pid} ${p.command.slice(0, 120)}`);
  }
  if (!kill) {
    console.log("nothing was ended; pass --kill to end them, or --all for the ones no run names");
    return;
  }

  for (const p of chosenProcs) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // gone between the listing and now
    }
  }
  await Bun.sleep(500);
  for (const p of chosenProcs) {
    if (!alive(p.pid)) continue;
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // gone between the check and the signal
    }
  }

  if (prune) await prunePaths();
};

if (import.meta.main) await main();
