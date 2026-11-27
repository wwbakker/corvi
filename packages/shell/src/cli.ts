/** Helpers for reading a CLI's output, shared by any package that shells out. `Shell.run`
 * carries the workspace environment; these turn its results into the tolerant shapes callers
 * branch on.
 */
import { Effect, Option, Schema } from "effect";

import { CliError } from "@corvi/contracts/errors";
import { Shell, type ShellCallOptions, type ShellResult } from "@corvi/contracts/capabilities";
import { DEFAULT_WORKSPACE, type WorkspaceDto } from "@corvi/contracts/config";
import { Workspace } from "@corvi/contracts/workspace";

/** `--json` output through the Schema, with a deliberate tolerance: a CLI that printed nothing,
 * or something this query did not expect, reads as the fallback rather than failing — the
 * documented silent fallback. */
export const cliJson =
  <S extends Schema.Constraint, B extends Schema.Schema.Type<S>>(schema: S, fallback: B) =>
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
export const soft = <R>(
  work: Effect.Effect<ShellResult, CliError, R>,
): Effect.Effect<ShellResult, never, R> =>
  Effect.catch(work, (e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr || e.message }));

/** A per-call bound: `run`'s options without the directory, which a `ShellRun` takes
 * positionally. */
export type ShellLimits = Omit<ShellCallOptions, "cwd">;

/** One CLI call, as every caller writes it. */
export type ShellRun = (
  cmd: readonly string[],
  cwd?: string,
  limits?: ShellLimits,
) => Effect.Effect<ShellResult, CliError>;

const noShell = (cmd: readonly string[]): CliError =>
  new CliError({
    tool: cmd[0] ?? "",
    command: cmd.join(" "),
    stderr: "",
    exitCode: 127,
    message: `${cmd.join(" ")} failed: no Shell in context`,
  });

/**
 * The one reader of the optional `Shell` and `Workspace` services. A `Shell` in context runs the
 * command with the request's workspace (or the default one, which carries no env); with none,
 * `fallback` runs instead — the application's node shell, or a 127 failure for a package that
 * cannot run a process itself. This is what lets a test script every command the core runs while
 * production code keeps one calling convention.
 */
export const withShell = (
  fallback: (
    cmd: readonly string[],
    cwd: string | undefined,
    workspace: WorkspaceDto | undefined,
    limits: ShellLimits | undefined,
  ) => Effect.Effect<ShellResult, CliError>,
): ShellRun => {
  return (cmd, cwd, limits) =>
    Effect.gen(function* () {
      const shell = yield* Effect.serviceOption(Shell);
      const workspace = yield* Effect.serviceOption(Workspace);
      if (Option.isSome(shell)) {
        return yield* shell.value
          .run(cmd, { cwd, ...limits })
          .pipe(
            Effect.provideService(Workspace, Option.isSome(workspace) ? workspace.value : DEFAULT_WORKSPACE),
          );
      }
      return yield* fallback(cmd, cwd, Option.isSome(workspace) ? workspace.value : undefined, limits);
    });
};

/** A package's own `sh`: a `Shell` in context, else a command-not-found failure. */
export const sh: ShellRun = withShell((cmd) => Effect.fail(noShell(cmd)));

/** The failure a non-zero exit throws: the command, its stderr (or stdout when it said nothing
 * there), and the exit code. */
export const shOrThrowWith = (
  run: ShellRun,
  cmd: readonly string[],
  cwd?: string,
  limits?: ShellLimits,
): Effect.Effect<string, CliError> =>
  Effect.flatMap(run(cmd, cwd, limits), (r) => {
    if (r.code === 0) return Effect.succeed(r.stdout);
    const stderr = r.stderr || r.stdout;
    return Effect.fail(
      new CliError({
        tool: cmd[0] ?? "",
        command: cmd.join(" "),
        stderr,
        exitCode: r.code,
        message: `${cmd.join(" ")} failed: ${stderr}`,
      }),
    );
  });

export const shOrThrow = (
  cmd: readonly string[],
  cwd?: string,
  limits?: ShellLimits,
): Effect.Effect<string, CliError> => shOrThrowWith(sh, cmd, cwd, limits);

/** `soft(run(...))` for a runner other than the package's own. */
export const shSoftWith = (
  run: ShellRun,
  cmd: readonly string[],
  cwd?: string,
  limits?: ShellLimits,
): Effect.Effect<ShellResult> => soft(run(cmd, cwd, limits));

export const shSoft = (cmd: readonly string[], cwd?: string): Effect.Effect<ShellResult> =>
  shSoftWith(sh, cmd, cwd);

/** A failure's message: every typed error carries the sentence the user sees, and anything else
 * falls back to `String(e)`. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
