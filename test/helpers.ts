import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunToken, runPidPath } from "../scripts/clean-test.ts";
import { Data, Effect, Layer, TestClock, TestContext } from "effect";
import type { Workspace } from "../src/workspace/server/index.ts";
import { capabilitiesLayer } from "../src/extension-host/services.ts";
import type { Capabilities } from "../src/extension-host/api.ts";
import { setRepos } from "../src/vendors/git.ts";
import { sh, type Result } from "../src/capabilities/shell.ts";
import { Shell, Workspace as WorkspaceTag } from "../src/capabilities/effect/tags.ts";
import { CacheLive, ChangesLive, SettingsLive } from "../src/extension-host/services.ts";
import type { CliError } from "../src/capabilities/effect/errors.ts";
import { toResponse } from "../src/capabilities/effect/http.ts";
import { swr } from "../src/capabilities/cache.ts";
import { workspaceById } from "../src/workspace/server/index.ts";
import type { Change } from "../src/domain/change.ts";
import { cancelChange } from "../src/change/server/index.ts";
import { fileDiff, localChanges } from "../src/extensions/review/server.ts";
import type { LocalStatus } from "../src/extensions/review/shared.ts";
import {
  deploy,
  versionsFor,
  type Buildable,
} from "../src/extensions/azure-devops/server.ts";


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
  // "wx" leaves that in place. A lone `bun test` has no wrapper, so its own pid stands in.
  if (!announced) {
    announced = true;
    try {
      writeFileSync(runPidPath(tmpdir(), token), String(process.pid), { flag: "wx" });
    } catch {
      // already written by the run's script, or a temp dir we cannot write: --all remains
    }
  }
  return token;
};

/** A temp dir whose name carries the run token, so the cleaner can tell whose it is. */
export const testTempDir = async (label: string): Promise<string> => {
  const token = testRun();
  return mkdtemp(join(tmpdir(), `corvi-${token}-${label}-`));
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
 * src/server.ts), and hand back the URL without its trailing slash. Readiness is the server's
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
 * request's `Workspace` tag (src/capabilities/shell.ts). Tests are Promise-shaped by contract, so they run the
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
 * tagged union (src/vendors/git.ts), and the tests read `{ change }` / `{ needsForce }`. */
export const runSetRepos = async (
  ...args: Parameters<typeof setRepos>
): Promise<{ change: import("../src/domain/change.ts").Change } | { needsForce: string[] }> => {
  const result = await runEffect(setRepos(...args));
  return result._tag === "Done" ? { change: result.change } : { needsForce: result.needsForce };
};

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


