/**
 * Ends what a test run left running, and nothing else.
 *
 *   bun run test:clean                    # what it would end, and what it leaves alone
 *   bun run test:clean --kill             # end it
 *   bun run test:clean --prune            # end it, and remove the temp dirs and files it left
 *   bun run test:clean --verbose          # also say so when there is nothing
 *
 * Tests start real things — bun servers, ttyd servers, whole tmux servers — and an aborted run
 * leaves them behind. Killing those by port or by process name is how a live IWE.app server and
 * its ttyd were once destroyed: from the outside they look exactly like test leftovers. So
 * ownership here is decided only by things a test's processes carry and the app's never do:
 *
 *   - a ttyd is a test's when the change directory in its command line is under `$TMPDIR/iwe-*`
 *     (the temp dirs the tests create; the app's ttyds serve `~/changes/...`);
 *   - a tmux server is a test's when its socket is under a `$TMPDIR/iwe-*` directory (the tests
 *     point TMUX_TMPDIR there; yours is the default socket);
 *   - a bun server is a test's when its command line carries `--iwe-test-run`, which the tests
 *     pass and src/server.ts ignores.
 *
 * Anything that only looks like IWE — the app's server, its terminal, your tmux — is listed as
 * left alone and is never signalled. `bun run test` runs the kill pass afterwards too (an EXIT
 * trap), so strays do not accumulate between runs in the first place.
 */
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

/** Whether a command line belongs to a test run. Pure and exported, so test/clean.test.ts can
 * pin the two shapes this must never confuse: a test's ttyd and the app's own. */
export const isTestCommand = (command: string, roots: readonly string[]): boolean => {
  if (command.includes("--iwe-test-run")) return true;
  const changeDir = /(?:^|\s)-c\s+(\S+)/.exec(command)?.[1];
  return changeDir !== undefined && underTestRoot(changeDir, roots);
};

/** Whether a tmux socket belongs to a test run. */
export const isTestSocket = (socket: string, roots: readonly string[]): boolean =>
  underTestRoot(socket, roots);

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

/** The only processes this tool is ever allowed to end: ttyd and the test's bun server. tmux
 * servers are ended through their own socket (known to be a test's) rather than by pid, so the
 * pattern here need not know a tmux server from a tmux client. */
const isKillable = (command: string): boolean =>
  command.startsWith("ttyd ") || /(?:^|\/)bun(?: |$).*src\/server\.ts/.test(command);

/** What the report lists as left alone: the things this tool could plausibly have ended and did
 * not — server and terminal processes. tmux is deliberately absent: it is only ever ended
 * through a socket proven to be a test's, so a tmux process in this list would be noise at best
 * and the test server just killed at worst. */
const looksLikeApp = (command: string): boolean =>
  command.startsWith("ttyd ") || /(?:^|\/)bun(?: |$).*src\/server\.ts/.test(command);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const main = async (): Promise<void> => {
  const kill = process.argv.includes("--kill") || process.argv.includes("--prune");
  const prune = process.argv.includes("--prune");
  const verbose = process.argv.includes("--verbose");
  const roots = await testRoots();
  const all = await processes();
  const testProcs = all.filter((p) => isKillable(p.command) && isTestCommand(p.command, roots));
  const sockets = await testSockets(roots);

  if (!testProcs.length && !sockets.length) {
    if (verbose) console.log("no test processes or tmux servers are running");
    // Leftover directories can outlive their processes — a timed-out test never reaches its own
    // cleanup — so pruning is still worth doing with nothing to kill.
    if (prune) await pruneLeftovers(roots);
    return;
  }

  const untouched = all.filter((p) => looksLikeApp(p.command) && !isTestCommand(p.command, roots));
  console.log(
    `${kill ? "ending" : "found"} ${testProcs.length} test process(es) and ${sockets.length} test tmux server(s):`,
  );
  for (const p of testProcs) console.log(`  ${p.pid} ${p.command.slice(0, 140)}`);
  for (const socket of sockets) console.log(`  tmux server on ${socket}`);
  // Named so the report itself teaches the difference, which is the whole point of the tool.
  if (untouched.length) {
    console.log(`${untouched.length} server/terminal process(es) left alone (not test-owned):`);
    for (const p of untouched) console.log(`  ${p.pid} ${p.command.slice(0, 140)}`);
  }
  if (!kill) {
    console.log("nothing was ended; pass --kill to end them");
    return;
  }

  for (const p of testProcs) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // gone between the listing and now
    }
  }
  for (const socket of sockets) await sh(["tmux", "-S", socket, "kill-server"]);
  await Bun.sleep(500);
  for (const p of testProcs) {
    if (!alive(p.pid)) continue;
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // gone between the check and the signal
    }
  }

  if (prune) await pruneLeftovers(roots);
};

/** Remove what aborted runs leave on disk under the test roots: the `iwe-*` entries the tests
 * create and their own cleanup did not reach. The kill pass has already run, so a surviving
 * test-owned process means another suite is mid-run and the directories are still in use. */
const pruneLeftovers = async (roots: readonly string[]): Promise<void> => {
  const running = (await processes()).filter(
    (p) => isKillable(p.command) && isTestCommand(p.command, roots),
  );
  if (running.length) {
    console.log(`not pruning: ${running.length} test process(es) are still running (another suite?)`);
    return;
  }
  const unique = [...new Set(await Promise.all(roots.map((root) => realpath(root).catch(() => root))))];
  const removed: string[] = [];
  for (const root of unique) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.name.startsWith("iwe-")) continue;
      const path = join(root, entry.name);
      await rm(path, { recursive: true, force: true }).then(
        () => removed.push(path),
        () => undefined, // something else is holding it; next time
      );
    }
  }
  if (removed.length) {
    console.log(`removed ${removed.length} leftover test path(s):`);
    for (const path of removed) console.log(`  ${path}`);
  }
};

if (import.meta.main) await main();
