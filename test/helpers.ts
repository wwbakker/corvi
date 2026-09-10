import { Effect } from "effect";
import type { Workspace } from "../src/config.ts";
import { capabilitiesLayer } from "../src/extensions/services.ts";
import { setRepos } from "../src/integrations/git.ts";
import { sh, type Result } from "../src/sh.ts";
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

/** Run an effect as the default workspace — what the retired Promise facades did, minus the
 * second public surface they were. */
export const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspaceById(undefined))));

/** The same, as the workspace named: for the tests that exercise per-workspace behaviour. */
export const runEffectWith = <A, E>(
  workspace: Workspace,
  effect: Effect.Effect<A, E, never>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspace)));

/** One CLI call, in the shape the retired `sh` facade returned: a timed-out CLI is exit code
 * 124, so tests branch on `code` exactly as the server does. */
export const runSh = (cmd: readonly string[], cwd?: string): Promise<Result> =>
  runEffect(
    sh(cmd, cwd).pipe(
      Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
    ),
  );

/** The stale-while-revalidate cache, with the Promise work the old `swr` facade took. */
export const runSwr = <T>(key: string, ttl: number, work: () => Promise<T>): Promise<T> =>
  runEffect(swr(key, ttl, Effect.tryPromise<T, unknown>({ try: work, catch: (e) => e })));

/** Editing a change's repositories, in the duck the old facade returned: the Effect API answers
 * in a tagged union (src/integrations/git.ts), and the tests read `{ change }` / `{ needsForce }`. */
export const runSetRepos = async (
  ...args: Parameters<typeof setRepos>
): Promise<{ change: import("../src/types.ts").Change } | { needsForce: string[] }> => {
  const result = await runEffect(setRepos(...args));
  return result._tag === "Done" ? { change: result.change } : { needsForce: result.needsForce };
};

/** Cancelling a change, in the duck the old Promise facade returned: the Effect API answers in a
 * tagged union (`{ _tag: "Done" }` / `{ _tag: "NeedsForce" }`), and the tests read
 * `{ change, loose }` / `{ needsForce }`. */
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
