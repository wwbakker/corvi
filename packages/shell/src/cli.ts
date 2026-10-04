/** Helpers for reading a CLI's output, shared by any package that shells out. `Shell.run`
 * carries the workspace environment; these turn its results into the tolerant shapes callers
 * branch on.
 */
import { Effect, Schema } from "effect";

import type { CliError } from "@corvi/contracts/errors";
import type { ShellResult } from "@corvi/contracts/capabilities";

/** `--json` output through the Schema, with a deliberate tolerance: a CLI that printed nothing,
 * or something this query did not expect, reads as the fallback rather than failing — the
 * documented silent fallback. */
export const cliJson = <S extends Schema.Constraint, B extends Schema.Schema.Type<S>>(
  schema: S,
  fallback: B,
) =>
  (stdout: string): Effect.Effect<B> =>
    stdout.trim()
      ? Effect.orElseSucceed(
          // JSON.parse produces mutable arrays at runtime; Schema's readonly type is tightened
          // back to the fallback's here. `orElseSucceed` consumes the SchemaError failure, so
          // the cast only narrows the success type to `B` and erases the (never for CLI JSON)
          // decoding services.
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout) as Effect.Effect<B>,
          () => fallback,
        )
      : Effect.succeed(fallback);

/** The ShellResult-branching contract: non-zero exits are data, so a timed-out CLI — the one failure
 * `Shell.run` raises — surfaces as exit code 124 with its message, which ShellResult-branching
 * callers branch on. The stderr falls back to the message: a `CliError` can carry its sentence
 * with nothing on stderr at all (a timeout names itself; a refused call names what was
 * missing), and dropping it here would hand the page an empty line where the reason was. */
export const soft = <R>(work: Effect.Effect<ShellResult, CliError, R>): Effect.Effect<ShellResult, never, R> =>
  Effect.catch(work, (e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr || e.message }));

/** A failure's message: every typed error carries the sentence the user sees, and anything else
 * falls back to `String(e)`. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
