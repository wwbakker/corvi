import { Effect } from "effect";
import { sh, type Result } from "../shell.ts";

/**
 * Helpers shared by every module that shells out or reports a failure, so each invariant is
 * stated once.
 */

/** The Result-branching contract: non-zero exits are data, so a timed-out CLI — the one failure
 * sh can raise — surfaces as exit code 124 with its message, which Result-branching callers
 * branch on. */
export const shSoft = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  Effect.catchAll(sh(cmd, cwd), (e) =>
    Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr }));

/** `--json` output through the Schema, re-exported from `@corvi/shell/cli` so the app's
 * callers keep one import while the helpers become package-owned. */
export { cliJson, messageOf } from "@corvi/shell/cli";


/** Filesystem failures are defects, not domain errors — the directories we read and write are
 * ours, so the raw rejection escapes as a defect. */
export const fs = <A>(work: () => Promise<A>): Effect.Effect<A> => Effect.orDie(Effect.tryPromise(work));
