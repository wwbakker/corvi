/**
 * How the application runs CLIs: the node shell from `@corvi/shell/node` with the policies
 * this app owns — the product's environment variables, the child-environment scrub
 * (src/capabilities/env.ts), the timeout and the concurrency limit — plus the helpers the
 * core reads.
 *
 * `sh` is the convenience every caller uses: a `Shell` service in context wins (that is what
 * lets a test script every command the core runs), and with none it runs the same node shell
 * directly, so startup and cache code keep working outside a request. The environment comes
 * from the `Workspace` tag at run time; outside a request it adds nothing.
 */
import { homedir } from "node:os";
import { Effect, Option } from "effect";

import { CliError } from "@corvi/contracts/errors";
import { Workspace } from "@corvi/contracts/workspace";
import { DEFAULT_WORKSPACE, type Workspace as WorkspaceConfig } from "@corvi/configuration/config";
import { Shell, type Result } from "@corvi/shell";
import { makeNodeShell, type TraceEntry } from "@corvi/shell/node";
import { childEnv } from "./env.ts";
import { env } from "./identity.ts";

export type { Result };

/** Calls, and what they cost, when CORVI_TRACE is set. The dashboard's cost is almost entirely
 * these processes, and which of them is expensive is not something to guess at. */
export const trace = new Map<string, TraceEntry>();

/** Seconds a CLI may run before it is killed. A hung `az` fails with a `CliError` naming the
 * command rather than hanging the server forever. `CORVI_CLI_TIMEOUT=0` disables the timeout
 * entirely. How many CLIs may run at once keeps a single refresh from forking thirty
 * processes (the mechanism is the node shell's gate). */
const nodeShell = makeNodeShell({
  timeoutSeconds: () => {
    const raw = process.env[env("CLI_TIMEOUT")];
    return raw === undefined ? 120 : Number(raw);
  },
  parallel: Number(process.env[env("PARALLEL")] ?? 8),
  environment: (base, extra) => childEnv(base, extra),
  trace,
});

const expand = (value: string): string =>
  value.startsWith("~") ? homedir() + value.slice(1) : value;

/** What to add to a subprocess's environment: the workspace's own variables, `~` expanded,
 * since these are paths in practice — `GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` —
 * and a shell would have done it. Empty outside a request. The workspace comes from the
 * `Workspace` tag (read at run time by `sh` and by the Shell capability's live layer), with
 * the default workspace when the call has none. */
export const envOf = (workspace: WorkspaceConfig | undefined): Record<string, string> => {
  const own = workspace?.env ?? {};
  return Object.fromEntries(Object.entries(own).map(([key, value]) => [key, expand(value)]));
};

/** One CLI call with the environment given explicitly, instead of read from the request
 * scope. This is what the Shell capability's live layer runs, so integration code depends on
 * the service and the `Workspace` tag. */
export const shWithEnv = (
  cmd: readonly string[],
  cwd: string | undefined,
  variables: Record<string, string>,
): Effect.Effect<Result, CliError> => nodeShell.run(cmd, { cwd, env: variables });

/** One CLI call, bounded by the shared semaphore: non-zero exit codes are a successful
 * `Result` — callers branch on `code`; the `CliError` channel is only for a timeout.
 *
 * A `Shell` service in context wins: delegation is what lets a test script every command the
 * core runs. The live Shell layer runs `shWithEnv` (not this), so there is no recursion. The
 * `Workspace` tag read here satisfies that Shell's own `Workspace` requirement — with the
 * default workspace when the call has none, which carries no env, exactly as the direct path.
 * With no Shell in context the call runs the node shell directly, exactly as before, so
 * startup and cache code keep working with none. The tag is read, not required, so this stays
 * runnable where no workspace exists. */
export const sh = (cmd: readonly string[], cwd?: string): Effect.Effect<Result, CliError> =>
  Effect.gen(function* () {
    const shell = yield* Effect.serviceOption(Shell);
    const workspace = yield* Effect.serviceOption(Workspace);
    if (Option.isSome(shell)) {
      return yield* shell.value.run(cmd, { cwd }).pipe(
        Effect.provideService(
          Workspace,
          Option.isSome(workspace) ? workspace.value : DEFAULT_WORKSPACE,
        ),
      );
    }
    const variables = envOf(Option.isSome(workspace) ? workspace.value : undefined);
    return yield* nodeShell.run(cmd, { cwd, env: variables });
  });

/** Run and throw on failure, for actions where the user should see what broke: the `CliError`
 * carries the command's stderr. */
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
