import { Effect } from "effect";
import { shSoftWith } from "@corvi/shell/cli";
import { sh, type ShellResult } from "../shell.ts";

/**
 * Helpers shared by every module that shells out or reports a failure, so each invariant is
 * stated once.
 */

/** The ShellResult-branching contract: non-zero exits are data, so a timed-out CLI — the one failure
 * sh can raise — surfaces as exit code 124 with its message, which ShellResult-branching callers
 * branch on. */
export const shSoft = (cmd: string[], cwd?: string): Effect.Effect<ShellResult> => shSoftWith(sh, cmd, cwd);

/** `--json` output through the Schema, re-exported from `@corvi/shell/cli` so the app's
 * callers keep one import while the helpers become package-owned. */
export { cliJson, messageOf } from "@corvi/shell/cli";

/** Filesystem failures are defects, not domain errors — the directories we read and write are
 * ours, so the raw rejection escapes as a defect. */
export const fs = <A>(work: () => Promise<A>): Effect.Effect<A> => Effect.orDie(Effect.tryPromise(work));

/** A failure's sentence for a journal: its own message, else its string form, else the caller's
 * fallback — never empty, because the page renders the detail as the reason. */
export const errorDetail = (error: unknown, fallback: string): string => {
  const own =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return own || String(error) || fallback;
};

/** A number from the environment, or the fallback: finite and at least `min`. The one reader for
 * every bounded wait and size, so an invalid or empty value falls back instead of disabling the
 * bound. */
export const envNumber = (name: string, fallback: number, min = 1): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
};
