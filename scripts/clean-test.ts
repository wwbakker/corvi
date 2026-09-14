/**
 * Ends what test runs left running, and nothing else.
 *
 *   bun run test:clean                  # list every test-owned process, and whose run it is
 *   bun run test:clean --kill           # end the leavings of runs that are gone
 *   bun run test:clean --kill --run=T   # end exactly run T (what a run's EXIT trap does)
 *   bun run test:clean --kill --all     # end every test-owned process (the escape hatch)
 *   bun run test:clean --prune          # ...and remove the temp dirs and pid-files it ended
 *   bun run test:clean --verbose        # also say so when there is nothing
 *
 * Tests start real things — servers on Node, whole tmux servers — and an aborted run leaves them
 * behind. Killing those by port or by process name is how a live IWE.app server was once
 * destroyed: from the outside they look exactly like test leftovers. So ownership here is
 * decided only by things a test's processes carry and the app's never do:
 *
 *   - a tmux server is a test's when its socket is under a `$TMPDIR/iwe-*` directory (the tests
 *     name it explicitly with -S and give it to the server as IWE_TMUX_SOCKET; IWE's own
 *     terminals live on the `iwe` socket, and anything else on the default socket is yours);
 *   - a server is a test's when its command line carries `--iwe-test-run`, which the tests pass
 *     and src/server.ts ignores. The app's server (`electron src/server.ts`) and a dev server
 *     (`node src/server.ts`) carry no marker.
 *
 * The prefix is the whole rule: an entry under `$TMPDIR` named `iwe-*` that no live run names is
 * a stray, and `--prune` removes it. Do not name your own scratch files `iwe-…` there — a
 * `/tmp/iwe-notes.log` reads as a run named `notes.log`.
 *
 * Which run, and whether that run is still alive, is the second question — the one that lets two
 * suites run at once. A run is named by a token, a `<base36>.<base36>` pair the dot keeps apart
 * from the human labels a temp dir also carries. Its resources carry the token too:
 *
 *   - the server in `--iwe-test-run=<token>`;
 *   - the tmux socket, under `<tmpdir>/iwe-<token>-...`;
 *   - and the run itself in `<tmpdir>/iwe-<token>.pid`, written by `testRun()` (test/helpers.ts)
 *     and holding its pid for as long as it lives.
 *
 * So the default `--kill` ends only runs whose pid-file is gone or whose pid is dead: a crash's
 * leavings, never a suite in progress. A run's own EXIT trap passes `--run=<token>` to end
 * exactly its own. `--all` is there for the day a pid-file lies (a reused pid can only make the
 * tool *skip* a dead run, not kill a live one, so the failure is a leak, not a casualty).
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
 * `$TMPDIR/iwe-x` is `/var/folders/.../T//iwe-x` and would not match the `T/iwe-` prefix. */
const normalize = (path: string): string => path.replace(/\/{2,}/g, "/");

const underTestRoot = (path: string, roots: readonly string[]): boolean => {
  const candidate = normalize(path);
  return roots.some((root) => candidate.startsWith(`${normalize(root)}/iwe-`));
};

/** Whether a command line belongs to a test run: only the marker every test server carries.
 * Pure and exported, so test/clean.test.ts can pin the shapes this must never confuse: a test's
 * server, the app's (`electron src/server.ts`), and a dev server (`node src/server.ts`). */
export const isTestCommand = (command: string): boolean => command.includes("--iwe-test-run");

/** Whether a tmux socket belongs to a test run. */
export const isTestSocket = (socket: string, roots: readonly string[]): boolean =>
  underTestRoot(socket, roots);

/** A run token: two base36 words joined by a dot. The dot is what makes it recognisable in a
 * path that also carries a human label, and what keeps `iwe-term-abc` (label `term`) from being
 * read as run `term`. */
const TOKEN = "[0-9a-z]+\\.[0-9a-z]+";

/** Whether a string is a run token in full. The parsers below match a token as a prefix, because
 * they read it out of a longer path or command line; test/helpers.ts refuses a hand-set
 * `IWE_TEST_RUN` that is not one, since the cleaner would otherwise leave that run's servers
 * behind as unattributable. */
export const isRunToken = (value: string): boolean => new RegExp(`^${TOKEN}$`).test(value);

/** The token a test process carries, or undefined: a resource with no token is one this tool
 * cannot attribute to a run (the app's dev server, or a leftover from before tokens), and is
 * left alone unless `--all`. The lookahead keeps a longer word from being read as a shorter
 * token: `--iwe-test-run=abc.defG` is not run `abc.def`. */
export const tokenOf = (command: string): string | undefined =>
  new RegExp(`--iwe-test-run=(${TOKEN})(?=\\s|$)`).exec(command)?.[1];

/** The token a path carries, or undefined: a resource with no token is one this tool cannot
 * attribute to a run (the app's, or a leftover from before tokens), and is left alone unless
 * `--all`. */
export const tokenFromPath = (path: string): string | undefined =>
  new RegExp(`(?:^|[\\\\/])iwe-(${TOKEN})(?=[-/]|$)`).exec(normalize(path))?.[1];

/** The token a pid-file name carries (`iwe-<token>.pid`), for pruning. */
const tokenFromPidFile = (name: string): string | undefined =>
  new RegExp(`^iwe-(${TOKEN})\\.pid$`).exec(name)?.[1];

/** Where a run writes its liveness: `<tmpdir>/iwe-<token>.pid`. The token names all of a run's
 * temp dirs, so one file answers for all of them. */
export const runPidPath = (root: string, token: string): string => join(root, `iwe-${token}.pid`);

type Proc = { pid: number; command: string };

const processes = async (): Promise<Proc[]> => {
  const { stdout } = await sh(["ps", "-Aww", "-o", "pid=,command="]);
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), command: match[2]! }));
};

/** The tmux sockets test runs left under the temporary directories. Resolved and deduped: the two
 * spellings of the temp root are one directory, and its sockets are one set. */
const testSockets = async (roots: readonly string[]): Promise<string[]> => {
  const sockets = new Set<string>();
  for (const root of roots) {
    for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory() || !dir.name.startsWith("iwe-")) continue;
      const testDir = join(root, dir.name);
      for (const inner of await readdir(testDir, { withFileTypes: true }).catch(() => [])) {
        if (!inner.isDirectory() || !inner.name.startsWith("tmux-")) continue;
        const socketDir = join(testDir, inner.name);
        // The directory, not the socket: fs.realpath on a socket fails with EOPNOTSUPP on macOS.
        const resolved = await realpath(socketDir).catch(() => socketDir);
        for (const file of await readdir(socketDir, { withFileTypes: true }).catch(() => [])) {
          if (file.isSocket()) sockets.add(join(resolved, file.name));
        }
      }
    }
  }
  return [...sockets];
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

/** The only processes this tool is ever allowed to end: the runtimes a test server can be. tmux
 * servers are ended through their own socket (known to be a test's) rather than by pid, so the
 * pattern here need not know a tmux server from a tmux client. */
const isKillable = (command: string): boolean =>
  /(?:^|\/)(?:bun|node)(?: |$).*src\/server\.ts/.test(command);

/** What the report lists as left alone: the things this tool could plausibly have ended and did
 * not — a server. tmux is deliberately absent: it is only ever ended through a socket proven to
 * be a test's, so a tmux process in this list would be noise at best and the test server just
 * killed at worst. */
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
      if (!entry.name.startsWith("iwe-")) continue;
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
  const sockets = await testSockets(roots);

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
  const chosenSockets = sockets.filter((s) => verdict(tokenFromPath(s)) === "chosen");

  if (!procs.length && !sockets.length) {
    if (verbose) console.log("no test processes or tmux servers are running");
    if (prune) {
      // Quiescent: nothing test-owned is running, so an `iwe-*` entry no run names is a stray
      // (an old run's, or a fixed-path log), and the old prune's behaviour is right.
      const removed = await pruneLeftovers(roots, (t) => all || run === t || !liveToken(t, roots), true);
      if (removed.length) console.log(`removed ${removed.length} leftover test path(s):\n  ${removed.join("\n  ")}`);
    }
    return;
  }

  console.log(
    `${kill ? "ending" : "found"} ${chosenProcs.length} test process(es) and ${chosenSockets.length} test tmux server(s)` +
      (all ? " (--all)" : run !== undefined ? ` (run ${run})` : " of runs that are gone") +
      ` — ${procs.length + sockets.length} test-owned in all:`,
  );
  for (const p of procs) console.log(`  ${p.pid} ${p.command.slice(0, 120)} ${note(tokenOf(p.command))}`);
  for (const socket of sockets) {
    console.log(`  tmux server on ${socket} ${note(tokenFromPath(socket))}`);
  }
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
  for (const socket of chosenSockets) await sh(["tmux", "-S", socket, "kill-server"]);
  await Bun.sleep(500);
  for (const p of chosenProcs) {
    if (!alive(p.pid)) continue;
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // gone between the check and the signal
    }
  }

  if (prune) {
    // Untokened leftovers are only safe to remove when nothing test-owned survived: a run too old
    // to name itself cannot be asked whether it is still using its directories.
    const stillRunning = (await processes()).filter((p) => isKillable(p.command) && isTestCommand(p.command));
    const covers = (token: string): boolean => all || run === token || !liveToken(token, roots);
    const removed = await pruneLeftovers(roots, covers, all || stillRunning.length === 0);
    if (removed.length) console.log(`removed ${removed.length} leftover test path(s):\n  ${removed.join("\n  ")}`);
  }
};

if (import.meta.main) await main();
