/** Helpers for reading a CLI's output, shared by any package that shells out. `Shell.run`
 * carries the workspace environment; these turn its results into the tolerant shapes callers
 * branch on.
 */
import { Effect, Schema } from "effect";

import type { CliError } from "@corvi/contracts/errors";
import type { Result } from "@corvi/contracts/capabilities";

/** `--json` output through the Schema, with a deliberate tolerance: a CLI that printed nothing,
 * or something this query did not expect, reads as the fallback rather than failing — the
 * documented silent fallback. */
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

/** The Result-branching contract: non-zero exits are data, so a timed-out CLI — the one failure
 * `Shell.run` raises — surfaces as exit code 124 with its message, which Result-branching
 * callers branch on. */
export const soft = <R>(work: Effect.Effect<Result, CliError, R>): Effect.Effect<Result, never, R> =>
  Effect.catchAll(work, (e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr }));

/** A failure's message: every typed error carries the sentence the user sees, and anything else
 * falls back to `String(e)`. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
