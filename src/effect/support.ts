import { Effect, Schema } from "effect";
import { sh, type Result } from "../sh.ts";

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

/** `--json` output through the Schema, with a deliberate tolerance: a CLI that printed nothing,
 * or something this query did not expect, reads as the fallback rather than failing — the
 * documented silent fallback (docs/guides/effect-conventions.md). */
export const cliJson = <A, I, B extends A>(schema: Schema.Schema<A, I>, fallback: B) =>
  (stdout: string): Effect.Effect<B> =>
    stdout.trim()
      ? Effect.orElseSucceed(
          // JSON.parse produces mutable arrays at runtime; Schema's readonly type is tightened
          // back to the fallback's here.
          Schema.decodeUnknown(Schema.parseJson(schema))(stdout) as Effect.Effect<B>,
          () => fallback,
        )
      : Effect.succeed(fallback);

/** A failure's message: every typed error carries the sentence the user sees, and anything else
 * falls back to `String(e)`. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Filesystem failures are defects, not domain errors — the directories we read and write are
 * ours, so the raw rejection escapes as a defect. */
export const fs = <A>(work: () => Promise<A>): Effect.Effect<A> => Effect.orDie(Effect.tryPromise(work));
