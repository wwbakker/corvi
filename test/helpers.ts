import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { isRunToken, runPidPath } from "../scripts/clean-test.ts";
import { Data, Effect, Layer, TestClock, TestContext } from "effect";
import type { Workspace } from "../apps/server/src/workspace/server/index.ts";
import { runtimeConfig, type Config } from "../apps/server/src/workspace/server/index.ts";
import { capabilitiesLayer } from "../apps/server/src/integrations/services.ts";
import type { Capabilities } from "../apps/server/src/integrations/api/capabilities.ts";
import { setRepos } from "../apps/server/src/vendors/git.ts";
import { sh, type Result } from "../apps/server/src/capabilities/shell.ts";
import { Shell } from "@corvi/shell";
import { Workspace as WorkspaceTag } from "@corvi/contracts/workspace";
import { CacheLive, ChangesLive, GitFactsLive, SettingsLive } from "../apps/server/src/integrations/services.ts";
import type { CliError } from "@corvi/contracts/errors";
import { toResponse } from "../apps/server/src/capabilities/effect/http.ts";
import { swr } from "../apps/server/src/capabilities/cache.ts";
import { workspaceById } from "../apps/server/src/workspace/server/index.ts";
import type { LegacyFlatSettings } from "@corvi/jira/legacy";
import type { Change } from "../apps/server/src/domain/change.ts";
import { cancelChange } from "../apps/server/src/change/server/index.ts";
import { fileDiff, localChanges } from "../apps/server/src/integrations/review/server.ts";
import type { LocalStatus } from "@corvi/contracts/integrations/review";
import {
  deploy,
  versionsFor,
  type Buildable,
} from "@corvi/azure-devops/server";


/** Whether this process has written the run's pid-file yet. */
let announced = false;

/** The token that names this run. The suite's own script sets `CORVI_TEST_RUN`; a lone
 * `bun test test/foo.test.ts` gets one from its pid and the clock. It is written into every temp
 * dir's name and into `<tmpdir>/corvi-<token>.pid`, which is what lets scripts/clean-test.ts tell
 * one run's resources from another's, and a live run from a crashed one. */
export const testRun = (): string => {
  const fromEnv = process.env.CORVI_TEST_RUN;
  // A hand-set token the cleaner cannot read would leave this run's servers and tmux sockets
  // behind as unattributable (`--all`-only). Refuse it here, before anything starts, rather than
  // leak them.
  if (fromEnv !== undefined && fromEnv !== "" && !isRunToken(fromEnv)) {
    throw new Error(
      `CORVI_TEST_RUN=${fromEnv} is not a run token: scripts/clean-test.ts reads tokens as ` +
        "<base36>.<base36> (two lowercase words joined by a dot, what `date +%s.$$` produces). " +
        "Leave it unset for a lone test file, or run the suite with `bun run test`.",
    );
  }
  const token =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : `${Date.now().toString(36)}.${process.pid.toString(36)}`;
  process.env.CORVI_TEST_RUN = token;
  // The run's script writes this with the wrapper shell's pid, which lives for the whole run;
  // "wx" leaves that in place. A lone `bun test` has no wrapper, so its own pid stands in —
  // under `--parallel`, the first *worker's* pid, and that worker is gone before the run is. A
  // pid-file naming a dead pid reads to scripts/clean-test.ts as a crashed run while its files
  // are still going, so a later claimant takes the file over when the pid in it is dead.
  if (!announced) {
    announced = true;
    const path = runPidPath(tmpdir(), token);
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
    } catch {
      try {
        if (!processAlive(Number(readFileSync(path, "utf8").trim()))) {
          writeFileSync(path, String(process.pid));
        }
      } catch {
        // a temp dir we cannot read or write: --all remains
      }
    }
  }
  return token;
};

/** A temp dir whose name carries the run token, so the cleaner can tell whose it is. */
export const testTempDir = async (label: string): Promise<string> => {
  const token = testRun();
  return mkdtemp(join(tmpdir(), `corvi-${token}-${label}-`));
};

/** This file's own world, applied before any test in it reads the configuration: `CORVI_ROOT`
 * and its siblings point into a directory no other test file shares. Product code that deletes
 * a change, an archive or a leftover mutates exactly these roots — shared per run, they were a
 * file running beside this one's state; per file, a test can only ever disturb itself.
 * `serverEnv` gives spawned servers the same guarantee; this is it for the tests that run the
 * product in their own process. Named for the run, so scripts/clean-test.ts takes it with the
 * rest of the run's leftovers. Made synchronously, so this module has no top-level await: a
 * module that finishes evaluating only after a promise leaves its later exports in their
 * temporal dead zone for a parallel worker that imports it (`--parallel` interleaves the
 * files' graphs), which reads as `Cannot access 'runEffect' before initialization`. */
const ownRoot = mkdtempSync(join(tmpdir(), `corvi-${testRun()}-root-`));
process.env.CORVI_ROOT = join(ownRoot, "changes");
process.env.CORVI_ARCHIVE_ROOT = join(ownRoot, "changes-archive");
process.env.CORVI_CONFIG = join(ownRoot, "config.json");
process.env.CORVI_CACHE = join(ownRoot, "cache.json");
process.env.XDG_STATE_HOME = join(ownRoot, "state");

/** The process's config snapshot, with the flat keys older files still carry: the preserve
 * decode keeps them on the object and `Config` does not type them. Production reads them where
 * it needs them in its own package (`@corvi/jira/legacy`'s fallback); a test that asserts they
 * survive a write reads them here, where the one cast lives. */
export const legacyConfig = (): Config & LegacyFlatSettings =>
  runtimeConfig() as Config & LegacyFlatSettings;

/** The per-workspace legacy keys an older file still carries on an entry: the loader preserves
 * them on read and no production type declares them, so a test that asserts one survived reads
 * it here. */
export type LegacyWorkspaceKeys = {
  readonly jira?: unknown;
  readonly azure?: unknown;
};

export const legacyWorkspace = (workspace: object): LegacyWorkspaceKeys =>
  workspace as LegacyWorkspaceKeys;

/** What a test may state on the config snapshot for a body: any resolved field, plus the
 * preserved flat keys `legacyConfig` reads. */
export type RuntimeConfigPatch = Partial<Config> & LegacyFlatSettings;

/** Run `body` with `patch` applied to the one config object every module holds by reference,
 * then put each patched key back exactly as it was — own property restored if the object had
 * one, absent key removed if it did not — even when the body throws, so a failed expectation
 * cannot leak a workspace into the next test. One body at a time: a file's tests run in order,
 * so a test that patches wraps its own body rather than a hook. */
export const withRuntimeConfig = async <T>(
  patch: RuntimeConfigPatch,
  body: () => Promise<T> | T,
): Promise<T> => {
  const config = runtimeConfig();
  const saved = (Object.keys(patch) as (keyof RuntimeConfigPatch)[]).map(
    (key) => [key, Object.getOwnPropertyDescriptor(config, key)] as const,
  );
  Object.assign(config, patch);
  try {
    return await body();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete (config as Record<string, unknown>)[key];
      else Object.defineProperty(config, key, descriptor);
    }
  }
};

/** Environment for a spawned test server: the OS picks the port (`CORVI_PORT=0`), and every
 * path is the file's own tmp dir, so parallel workers share nothing — not the changes, the
 * config, the built page, the cache file, or the tmux socket. `TMUX` is removed rather than
 * overridden: inside a tmux session it wins over `TMUX_TMPDIR`, and every tmux command the
 * server runs — `kill-server` included — would reach the session you are working in.
 * `CORVI_TMUX_SOCKET` is removed for the same reason: it is a blessed override for tests and
 * sandboxes (docs/guides/testing.md), so an inherited one would join this server to a
 * foreign tmux server instead of the per-file socket above. A file that wants its own socket
 * sets it deliberately after the scrub, as terminal.test.ts does. */
export const serverEnv = (
  tmp: string,
  extra: Record<string, string> = {},
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CORVI_ROOT: join(tmp, "changes"),
    CORVI_ARCHIVE_ROOT: join(tmp, "changes-archive"),
    CORVI_CONFIG: join(tmp, "config.json"),
    XDG_STATE_HOME: join(tmp, "state"),
    CORVI_CACHE: join(tmp, "cache.json"),
    TMUX_TMPDIR: tmp,
    CORVI_PORT: "0",
    ...extra,
  };
  delete env.TMUX;
  delete env.CORVI_TMUX_SOCKET;
  return env;
};

/** Read a spawned server's stdout until it says where it is listening (`corvi on <url>`,
 * apps/server/src/server.ts), and hand back the URL without its trailing slash. Readiness is the server's
 * own line rather than a poll: a random port picked here once landed on a busy one, and then
 * the test said only "connection refused" (test/node-runtime.test.ts). Rejects if the
 * server exits first, or says nothing within a minute. */
export const waitForUrl = async (
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 60_000,
): Promise<string> => {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const failure = proc.exited.then((): string => {
    throw new Error(`the server exited before it was up:\n${seen}`);
  });
  // The race below observes the outcome; this silences the loser path, which would otherwise
  // reject unhandled when the server is killed at the end of a passing test.
  failure.catch(() => undefined);
  const line = (async (): Promise<string> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the server exited before it was up:\n${seen}`);
      seen += decoder.decode(value, { stream: true });
      const found = /corvi on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(seen);
      if (found?.[1]) return found[1].replace(/\/$/, "");
    }
  })();
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(
      () => reject(new Error(`the server did not come up within ${timeoutMs}ms:\n${seen}`)),
      timeoutMs,
    ),
  );
  return await Promise.race([line, failure, timeout]);
};

/** How long the suite is willing to wait, for a wait deadline or a test timeout alike.
 *
 * Waits are condition-driven throughout — a test never sleeps for a duration it guessed — but a
 * wait still needs a deadline, and that deadline is a claim about the machine's speed. `budget`
 * states each one normally (30s for a wait, 60s for a browser test) and scales them all by
 * `CORVI_TEST_WAIT_SCALE`, so a loaded CI runner sets one variable — `3` triples every deadline
 * and every test timeout — instead of the tests growing deadlier guesses. The scaling is
 * multiplicative on purpose: a wait's deadline must stay inside its test's timeout, and scaling
 * both together keeps that true whatever the factor. */
export const budget = (ms: number): number =>
  Math.round(ms * (Number(process.env.CORVI_TEST_WAIT_SCALE) || 1));

/** Poll until a value is what it should be. Waiting is condition-driven throughout: a test
 * never sleeps for a duration it guessed — a shell starting, a strip refreshing and a file
 * appearing each happen when they happen, so the tests wait for the fact. The 200ms step between
 * reads is the one timer, shared by every wait rather than repeated in each test; `budgetMs` is
 * a failure deadline (`budget(...)`, scaled for slow machines), never a guess at when the fact
 * arrives. The last value read comes back, so the expect after it can say what it saw. */
export const until = async <T>(
  read: () => Promise<T>,
  want: T,
  budgetMs = budget(30_000),
  stepMs = 200,
): Promise<T> => {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (last !== want && Date.now() < deadline) {
    await Bun.sleep(stepMs);
    last = await read();
  }
  return last;
};

/** Wait for a condition that is a gate rather than an assertion: on a timeout it names what
 * never happened and how long it waited for it, where the expect after it could only say "the
 * file was missing". */
export const waitFor = async (
  what: string,
  read: () => Promise<boolean>,
  budgetMs = budget(30_000),
): Promise<void> => {
  if (!(await until(read, true, budgetMs))) {
    throw new Error(`timed out waiting for ${what} (after ${budgetMs}ms)`);
  }
};

/** Close every page the browser still has open — and screenshot each one first when
 * `CORVI_TEST_ARTIFACTS` names a directory (CI uploads it on failure), so a failed test leaves
 * what it saw behind it rather than only what its expects could say. A test that fails mid-way
 * often skips its own `page.close()`: the pages still open at this moment are exactly the ones
 * worth keeping and closing, because a page left open keeps its pty attached and the next
 * test's client-count gates could never be satisfied. */
export const closePages = async (browser: Browser | undefined, label: string): Promise<void> => {
  const shots = process.env.CORVI_TEST_ARTIFACTS;
  const pages = (browser?.contexts() ?? []).flatMap((context) => context.pages());
  if (shots !== undefined && pages.length > 0) {
    await mkdir(shots, { recursive: true });
    for (const [index, page] of pages.entries()) {
      const name = `${label}-${Date.now()}-${index}.png`;
      await page.screenshot({ path: join(shots, name) }).catch(() => undefined);
    }
  }
  for (const page of pages) await page.close().catch(() => undefined);
};

/** Whether an id names a process that is there. A pid of nothing is a pid of no one. */
const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A machine-wide lock for the one piece of state every suite on the computer shares: the system
 * clipboard. The clipboard test's whole subject is that a copy reaches it and a paste comes back
 * out — and with two suites running at once (several agents on one machine routinely run this
 * suite concurrently), one run's `writeText("")` erases the other's marker mid-wait and both
 * flake. Held around that test's body, the clipboard has one user at a time no matter how many
 * suites are up.
 *
 * `mkdir` is the lock, because creating a directory is atomic; the owner's pid is kept inside
 * it, and a lock whose owner is gone is taken over — or one old enough that its owner died
 * between making it and naming itself. The directory is dot-prefixed on purpose:
 * scripts/clean-test.ts sweeps `$TMPDIR/corvi-*`, and sweeping a lock another suite is holding
 * is exactly what it must never do. */
export const withMachineLock = async <T>(what: string, body: () => Promise<T>): Promise<T> => {
  const dir = join(tmpdir(), `.corvi-test-${what}.lock`);
  const deadline = Date.now() + budget(90_000);
  for (;;) {
    try {
      await mkdir(dir);
      writeFileSync(join(dir, "owner"), String(process.pid));
      break;
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(join(dir, "owner"), "utf8").trim());
      } catch {
        // no owner named yet, or unreadable: treated as no owner
      }
      const ageMs = Date.now() - ((await stat(dir).catch(() => undefined))?.mtimeMs ?? Date.now());
      if (!processAlive(owner) && ageMs > 5_000) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the machine's ${what} lock (${dir})`);
    }
    await Bun.sleep(200);
  }
  try {
    return await body();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** `sun_path` is 104 bytes including the terminating NUL, so a path may be 103 characters. */
const UNIX_SOCKET_PATH_MAX = 103;

/** Where a test's private tmux server keeps its socket.
 *
 * Short because a unix socket path is capped at 103 characters, and macOS spends most of that
 * before a test has named anything. `$TMPDIR` there is `/var/folders/<2>/<24>/T`, which tmux
 * resolves to `/private/var/folders/...` — 56 characters on this machine — and tmux then appends
 * `/tmux-<uid>/default`, 17 more. That leaves 29 for the directory the test hands it, and
 * `testTempDir("term")` makes 32 of them (`corvi-<token>-term-XXXXXX`, with the 16-character token
 * `bun run test` sets). tmux then starts no server at all — "File name too long" on the connect —
 * and every terminal test fails against an empty pane with nothing to say why. On Linux `$TMPDIR`
 * is `/tmp` and none of this is ever close.
 *
 * So the socket gets a directory of its own: the run token, which is what lets the cleaner
 * attribute it, and one short word. No label and no random suffix — there is no room, and the
 * token already tells two runs apart. The `corvi-` prefix stays, because a socket under a
 * `$TMPDIR/corvi-*` directory is what makes the server a test's own (scripts/clean-test.ts). The
 * length is checked rather than hoped for, since the failure is otherwise silent. */
export const tmuxTempDir = async (): Promise<string> => {
  const dir = join(tmpdir(), `corvi-${testRun()}-tmux`);
  await mkdir(dir, { recursive: true });
  // Resolved, because that is the path tmux puts on the socket: /var/folders/... is a symlink
  // into /private/var/folders/.... The check assumes tmux's own `<tmpdir>/tmux-<uid>/default`.
  const socket = join(await realpath(dir), `tmux-${process.getuid?.() ?? 0}`, "default");
  if (socket.length > UNIX_SOCKET_PATH_MAX) {
    throw new Error(
      `the test's tmux socket path is ${socket.length} characters, over the ${UNIX_SOCKET_PATH_MAX} ` +
        `a unix socket allows: ${socket}. Shorten the run token (CORVI_TEST_RUN), or this directory's name.`,
    );
  }
  return dir;
};

/**
 * The one seam between the Promise-shaped tests and the Effect API.
 *
 * The server's modules are Effects, and where a call shells out the environment comes from the
 * request's `Workspace` tag (apps/server/src/capabilities/shell.ts). Tests are Promise-shaped by contract, so they run the
 * Effect here rather than through a request: this provides the capability services, the tag
 * included, and hands back a Promise. Nothing else in the test suite needs to know about layers.
 */

/** Run an effect as the default workspace, with the capability services in place. An effect
 * that requires nothing is one that requires fewer capabilities, so the same helper serves both
 * the pure effects and the ones that go through `Changes` or `Shell`. */
export const runEffect = <A, E>(effect: Effect.Effect<A, E, Capabilities>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspaceById(undefined))));

/** The same, as the workspace named: for the tests that exercise per-workspace behaviour. */
export const runEffectWith = <A, E>(
  workspace: Workspace,
  effect: Effect.Effect<A, E, never>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspace)));

/** Run an effect under Effect's `TestClock`, where time moves only when the effect advances it
 * with `TestClock.adjust`. The capabilities are merged in as `runEffect` does, so the same effect
 * that runs in a request also runs here.
 *
 * The test clock starts at the wall clock's `now`: the cache's `ageOf` stays synchronous and on
 * the wall clock by contract, so a freshly produced entry must still read as fresh next to it.
 * Only relative advances matter, so the tests reason in offsets and behave the same at any date. */
export const runEffectWithTestClock = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(Date.now()), effect).pipe(
      Effect.provide(
        Layer.merge(TestContext.TestContext, capabilitiesLayer(workspaceById(undefined))),
      ),
    ),
  );

/** A typed stand-in for a failed vendor in a test: the language service forbids a global
 * `Error` in an Effect failure channel, and the code under test only reads its message. */
export class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

/** A command a fake Shell was asked to run, in the order it was asked. */
export type ShellCall = { cmd: readonly string[]; cwd?: string };

/** A scripted Shell. `responses` maps a command line (`cmd.join(" ")`) to what it answers: a
 * string is stdout with exit 0, and an object may set `code`, `stdout` and `stderr`. The function
 * form is there for a command whose answer differs per call. Commands with no scripted answer
 * exit 0 with empty output, and every call lands in `calls` — the commands asked for, which a
 * test asserts against to prove a core read went through the seam. */
export type FakeShell = {
  calls: ShellCall[];
  run: (
    cmd: readonly string[],
    opts?: { cwd?: string },
  ) => Effect.Effect<Result, CliError, WorkspaceTag>;
};

/** Build a scripted Shell (see `FakeShell`). */
export const fakeShell = (
  responses:
    | Record<string, string | Partial<Result>>
    | ((cmd: readonly string[]) => string | Partial<Result> | undefined) = {},
): FakeShell => {
  const calls: ShellCall[] = [];
  const answer = (cmd: readonly string[]): Result => {
    const scripted = typeof responses === "function" ? responses(cmd) : responses[cmd.join(" ")];
    if (scripted === undefined) return { code: 0, stdout: "", stderr: "" };
    if (typeof scripted === "string") return { code: 0, stdout: scripted, stderr: "" };
    return {
      code: scripted.code ?? 0,
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
    };
  };
  return {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      return Effect.succeed(answer(cmd));
    },
  };
};

/** Run an effect with a fake Shell in place of the real one, as the default workspace. The
 * workspace tag is provided alongside the Shell because the Shell service's `run` requires it,
 * exactly as the host provides both. `sh` reads the Shell from context and delegates, so a core
 * integration function can be driven with no subprocess. Extension effects additionally read
 * `Cache`, `Settings` and `Changes` from context, so those ride along with their live layers. */
export const runWithShell = <A, E, R>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect as Effect.Effect<A, E, never>,
      Layer.mergeAll(
        Layer.succeed(Shell, shell),
        Layer.succeed(WorkspaceTag, workspaceById(undefined)),
        CacheLive,
        SettingsLive,
        ChangesLive,
        GitFactsLive,
      ),
    ),
  );

/** A route effect run with a scripted Shell, mapped to a Response exactly as the server maps it
 * (`runRoute`'s error handling), so a route's readiness path can be exercised without the real
 * CLI. Pair with `withChangeEffect` for the request plumbing. */
export const runRouteWithShell = (
  shell: FakeShell,
  effect: Effect.Effect<Response, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.provide(
      effect.pipe(
        Effect.catchAll((error) => Effect.succeed(toResponse(error))),
        Effect.catchAllDefect((defect) => Effect.succeed(toResponse(defect))),
      ),
      Layer.mergeAll(
        Layer.succeed(Shell, shell),
        Layer.succeed(WorkspaceTag, workspaceById(undefined)),
        CacheLive,
        SettingsLive,
        ChangesLive,
        GitFactsLive,
      ),
    ),
  );

/** One CLI call, Promise-shaped for the tests: a timed-out CLI is exit code 124, so tests
 * branch on `code` exactly as the server does. */
export const runSh = (cmd: readonly string[], cwd?: string): Promise<Result> =>
  runEffect(
    sh(cmd, cwd).pipe(
      Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
    ),
  );

/** The stale-while-revalidate cache, around a test's Promise-shaped work. */
export const runSwr = <T>(key: string, ttl: number, work: () => Promise<T>): Promise<T> =>
  runEffect(
    swr(
      key,
      ttl,
      Effect.tryPromise<T, TestError>({
        try: work,
        catch: (e) => new TestError({ message: e instanceof Error ? e.message : String(e) }),
      }),
    ),
  );

/** Editing a change's repositories, in the duck the tests read: the Effect API answers in a
 * tagged union (apps/server/src/vendors/git.ts), and the tests read `{ change }` / `{ needsForce }`. */
export const runSetRepos = async (
  ...args: Parameters<typeof setRepos>
): Promise<{ change: import("../apps/server/src/domain/change.ts").Change } | { needsForce: string[] }> => {
  const result = await runEffect(setRepos(...args));
  return result._tag === "Done" ? { change: result.change } : { needsForce: result.needsForce };
};

/** The checkout specs a list of source paths becomes: worktrees on the change's branch, unless
 * a path is named in place or given a base — the shape `ChangeDraft` and the request bodies
 * carry. `base` becomes both where the branch starts and what a pull request merges into, which
 * is what one field meant before they were split. */
export const checkoutsOf = (
  paths: string[],
  direct: string[] = [],
  base: Record<string, string> = {},
): import("@corvi/contracts/api").CheckoutSpecDto[] =>
  paths.map((path) => ({
    path,
    location: direct.includes(path) ? ("original" as const) : ("new" as const),
    branch: { kind: "change" as const },
    ...(base[path] !== undefined ? { base: base[path], target: base[path] } : {}),
  }));

/** Cancelling a change, in the duck the tests read: the Effect API answers in a tagged union
 * (`{ _tag: "Done" }` / `{ _tag: "NeedsForce" }`), and the tests read `{ change, loose }` /
 * `{ needsForce }`. */
export const runCancel = async (
  ...args: Parameters<typeof cancelChange>
): Promise<{ change: Change; loose: string[] } | { needsForce: string[] }> => {
  const result = await runEffect(cancelChange(...args));
  return result._tag === "Done"
    ? { change: result.change, loose: result.loose }
    : { needsForce: result.needsForce };
};

/** What is uncommitted in one repository, Promise-shaped for the tests. */
export const runLocalChanges = (
  ...args: Parameters<typeof localChanges>
): Promise<LocalStatus> => runEffect(localChanges(...args));

/** One file's diff, Promise-shaped for the tests. */
export const runFileDiff = (...args: Parameters<typeof fileDiff>): Promise<string> =>
  runEffect(fileDiff(...args));

/** Recent builds of a service, Promise-shaped for the tests. */
export const runVersionsFor = (
  ...args: Parameters<typeof versionsFor>
): Promise<Buildable[]> => runEffect(versionsFor(...args));

/** Triggering a deploy, Promise-shaped for the tests. */
export const runDeploy = (
  ...args: Parameters<typeof deploy>
): Promise<{ runId: number; url?: string }> => runEffect(deploy(...args));


