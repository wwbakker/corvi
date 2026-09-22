/** The Shell capability as the github client uses it: this package's own `sh`, `shOrThrow` and
 * `soft`. The service is read optionally, the way the application's own `sh` reads it, so a
 * scripted Shell in context sees every command and the package's effects stay requirement-free.
 */
import { CliError } from "@corvi/contracts/errors";
import { Shell, type Result } from "@corvi/contracts/capabilities";
import { Workspace } from "@corvi/contracts/workspace";
import { DEFAULT_WORKSPACE } from "@corvi/contracts/config";
import { soft } from "@corvi/shell/cli";
import { Effect, Option } from "effect";

export type { Result };

const missing = (cmd: readonly string[]): CliError =>
  new CliError({
    tool: cmd[0] ?? "",
    command: cmd.join(" "),
    stderr: "",
    exitCode: 127,
    message: `${cmd.join(" ")} failed: no Shell in context`,
  });

export const sh = (cmd: readonly string[], cwd?: string): Effect.Effect<Result, CliError> =>
  Effect.gen(function* () {
    const shell = yield* Effect.serviceOption(Shell);
    if (Option.isNone(shell)) return yield* missing(cmd);
    const workspace = yield* Effect.serviceOption(Workspace);
    // The Shell service reads its environment from the Workspace tag at run time; outside a
    // request the default workspace carries no env, exactly as the application's `sh` behaves.
    return yield* shell.value.run(cmd, { cwd }).pipe(
      Effect.provideService(Workspace, Option.isSome(workspace) ? workspace.value : DEFAULT_WORKSPACE),
    );
  });

export const shOrThrow = (cmd: readonly string[], cwd?: string): Effect.Effect<string, CliError> =>
  Effect.flatMap(sh(cmd, cwd), (r) => {
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

export const shSoft = (cmd: readonly string[], cwd?: string): Effect.Effect<Result> =>
  soft(sh(cmd, cwd));
