import { Effect, Schema } from "effect";
import { sh, type Result } from "../sh.ts";

/**
 * Helpers shared by every module that shells out or reports a failure. Each had a copy per file
 * before this; they live here now, comment and all, so the invariant is stated once.
 */

/** The Result-branching contract of the old sh(), kept: non-zero exits are data, so a timed-out
 * CLI — the one failure sh can raise — surfaces as exit code 124 with its message, which
 * Result-branching callers branch on. */
export const shSoft = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  Effect.catchAll(sh(cmd, cwd), (e) =>
    Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr }));

/** `--json` output through the Schema, with the tolerance the old sh.ts json() had: a CLI that
 * printed nothing, or something this query did not expect, reads as the fallback rather than
 * failing — the documented silent fallback (docs/guides/effect-conventions.md). */
export const cliJson = <A, I, B extends A>(schema: Schema.Schema<A, I>, fallback: B) =>
  (stdout: string): Effect.Effect<B> =>
    stdout.trim()
      ? Effect.orElseSucceed(
          // JSON.parse produces mutable arrays at runtime; Schema's readonly type is tightened
          // back to the fallback's here, which is what the old cast did.
          Schema.decodeUnknown(Schema.parseJson(schema))(stdout) as Effect.Effect<B>,
          () => fallback,
        )
      : Effect.succeed(fallback);

/** A failure's message, exactly as the old `e instanceof Error ? e.message : String(e)` read it:
 * every typed error carries the sentence users saw before. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Filesystem failures are defects, not domain errors — the directories we read and write are
 * ours, and the old code let the raw rejection escape the same way. */
export const fs = <A>(work: () => Promise<A>): Effect.Effect<A> => Effect.orDie(Effect.tryPromise(work));
