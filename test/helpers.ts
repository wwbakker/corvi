import { Effect, Layer, TestClock, TestContext } from "effect";
import type { Workspace } from "../src/config.ts";
import { capabilitiesLayer } from "../src/extensions/services.ts";
import { setRepos } from "../src/integrations/git.ts";
import { sh, type Result } from "../src/sh.ts";
import { Shell, Workspace as WorkspaceTag } from "../src/effect/tags.ts";
import type { CliError } from "../src/effect/errors.ts";
import { swr } from "../src/cache.ts";
import { workspaceById } from "../src/workspaces.ts";
import type { Change } from "../src/types.ts";
import { cancelChange } from "../src/cancel.ts";
import { fileDiff, localChanges, type LocalStatus } from "../src/local.ts";
import {
  deploy,
  versionsFor,
  type Buildable,
} from "../src/extensions/deployments/server.ts";

/**
 * The one seam between the Promise-shaped tests and the Effect API.
 *
 * The server's modules are Effects, and where a call shells out the environment comes from the
 * request's `Workspace` tag (src/sh.ts). Tests are Promise-shaped by contract, so they run the
 * Effect here rather than through a request: this provides the capability services, the tag
 * included, and hands back a Promise. Nothing else in the test suite needs to know about layers.
 */

/** Run an effect as the default workspace. */
export const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
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
 * integration function can be driven with no subprocess. */
export const runWithShell = <A, E>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(
        Layer.succeed(Shell, shell),
        Layer.succeed(WorkspaceTag, workspaceById(undefined)),
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
  runEffect(swr(key, ttl, Effect.tryPromise<T, unknown>({ try: work, catch: (e) => e })));

/** Editing a change's repositories, in the duck the tests read: the Effect API answers in a
 * tagged union (src/integrations/git.ts), and the tests read `{ change }` / `{ needsForce }`. */
export const runSetRepos = async (
  ...args: Parameters<typeof setRepos>
): Promise<{ change: import("../src/types.ts").Change } | { needsForce: string[] }> => {
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
