import { Duration, Effect, Option } from "effect";
import { homedir } from "node:os";
import { CliError } from "./effect/errors.ts";
import { Workspace } from "./effect/tags.ts";
import type { Workspace as WorkspaceConfig } from "./config.ts";

/** Thin wrapper around child processes: integrations shell out to the vendors' own CLIs,
 * which means we inherit their auth (gh auth login, az login, ...) and store no secrets. */
export type Result = { code: number; stdout: string; stderr: string };

/** CLIs colour their errors even when not on a TTY; those codes would end up in the UI. */
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "").trim();

/** Calls, and what they cost, when IWE_TRACE is set. The dashboard's cost is almost entirely
 * these processes, and which of them is expensive is not something to guess at. */
export const trace = new Map<string, { calls: number; cpu: number; wall: number }>();

/** How a call is grouped in the trace: the tool and its subcommand, not the arguments. */
const traceKey = (cmd: readonly string[]): string =>
  ["git", "gh", "az", "jira", "tmux"].includes(cmd[0] ?? "")
    ? cmd.slice(0, cmd[0] === "az" ? 3 : 2).join(" ")
    : (cmd[0] ?? "");

const toolOf = (cmd: readonly string[]): string => cmd[0] ?? "";

/**
 * Seconds a CLI may run before it is killed. A hung `az` used to hang the server forever; now
 * the call fails with a `CliError` naming the command. This is the one sanctioned behavior
 * change of the migration. `IWE_CLI_TIMEOUT=0` disables the timeout entirely.
 */
const timeoutSeconds = (): number => {
  const raw = process.env.IWE_CLI_TIMEOUT;
  return raw === undefined ? 120 : Number(raw);
};

const failCli = (cmd: readonly string[], stderr: string, exitCode: number, message?: string): CliError =>
  new CliError({
    tool: toolOf(cmd),
    command: cmd.join(" "),
    stderr,
    exitCode,
    message: message ?? stderr,
  });

const expand = (value: string): string =>
  value.startsWith("~") ? homedir() + value.slice(1) : value;

/** What to add to a subprocess's environment: the workspace's own variables, `~` expanded,
 * since these are paths in practice — `GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_CONFIG_FILE` —
 * and a shell would have done it. Empty outside a request, which is every call IWE made before
 * workspaces existed. The workspace comes from the `Workspace` tag (src/effect/tags.ts), read
 * at run time by `sh` and by the Shell capability's live layer (src/extensions/services.ts). */
export const envOf = (workspace: WorkspaceConfig | undefined): Record<string, string> => {
  const own = workspace?.env ?? {};
  return Object.fromEntries(Object.entries(own).map(([key, value]) => [key, expand(value)]));
};

/**
 * How many CLIs may run at once. A dashboard asks about six repositories in parallel and each
 * asks two or three vendors, so without a bound a single refresh forks thirty processes — and
 * `az` alone is a few hundred milliseconds of CPU each. Queueing them costs nothing in wall
 * time on a laptop with fewer cores than that, and keeps the machine usable while it happens.
 */
const LIMIT = Number(process.env.IWE_PARALLEL ?? 8);

/** The one gate every CLI call passes through, replacing the hand-rolled slot() queue. */
const gate = Effect.runSync(Effect.makeSemaphore(LIMIT));

const spawnEffect = (
  cmd: readonly string[],
  cwd: string | undefined,
  env: Record<string, string>,
): Effect.Effect<Result, CliError> =>
  Effect.gen(function* () {
    const started = process.env.IWE_TRACE ? Bun.nanoseconds() : 0;
    let proc;
    try {
      // Whose login this runs as: a workspace may point `gh`, `az` and `jira` at another account.
      // Empty outside a request, which is every call IWE made before workspaces existed.
      proc = Bun.spawn([...cmd], {
        cwd,
        env: Object.keys(env).length ? { ...process.env, ...env } : undefined,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      // A missing tool, or a working directory that is not there any more — a repository moved
      // or deleted out from under a change. That is a failed command, not a broken server: every
      // caller already knows what to do with a non-zero code, and none of them expect a throw.
      return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
    const read = Effect.all([
      Effect.promise(() => new Response(proc.stdout).text()),
      Effect.promise(() => new Response(proc.stderr).text()),
      Effect.promise(() => proc.exited),
    ]);
    // A timed-out `git` that keeps running is a leak, not a timeout: whatever interrupted the
    // read — a deadline or a shutdown — kills the child first. The hook sits on the read
    // itself, the effect the interruption actually lands on (not on the CliError failure
    // the timeout is turned into afterwards).
    const seconds = timeoutSeconds();
    const killHook = Effect.onInterrupt(() => Effect.sync(() => proc.kill()));
    const guarded = seconds > 0
      ? read.pipe(
          killHook,
          Effect.timeout(Duration.seconds(seconds)),
          Effect.catchTag("TimeoutException", () =>
            Effect.fail(failCli(cmd, `${cmd.join(" ")} timed out after ${seconds} seconds`, 124))),
        )
      : read.pipe(killHook);
    const [stdout, stderr, code] = yield* guarded;
    if (started) {
      const usage = proc.resourceUsage();
      const key = traceKey(cmd);
      const seen = trace.get(key) ?? { calls: 0, cpu: 0, wall: 0 };
      trace.set(key, {
        calls: seen.calls + 1,
        cpu: seen.cpu + (usage ? Number(usage.cpuTime.user + usage.cpuTime.system) / 1000 : 0),
        wall: seen.wall + (Bun.nanoseconds() - started) / 1e6,
      });
    }
    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  });

/** One CLI call with the environment given explicitly, instead of read from the request
 * scope. This is what the Shell capability (src/extensions/services.ts) runs, so extension
 * code depends on the service and the Workspace tag rather than on the ambient store. */
export const shEffectWithEnv = (
  cmd: readonly string[],
  cwd: string | undefined,
  env: Record<string, string>,
): Effect.Effect<Result, CliError> => gate.withPermits(1)(spawnEffect(cmd, cwd, env));

/** One CLI call, bounded by the shared semaphore: `withPermits` releases on failure and on
 * interruption, so a killed or timed-out call cannot strand the gate. Non-zero exit codes are a
 * successful `Result` — callers branch on `code`; the `CliError` channel is only for a timeout,
 * the one failure the old code could not represent (it hung forever instead).
 *
 * The environment is read from the `Workspace` tag at run time: the request the call belongs to
 * provides it, and outside a request (`serviceOption` is none) it adds nothing — exactly what
 * the old ambient store returned as `undefined`. The tag is read, not required, so this stays
 * runnable from startup and cache code with no workspace in sight. */
export const sh = (cmd: readonly string[], cwd?: string): Effect.Effect<Result, CliError> =>
  gate.withPermits(1)(
    Effect.gen(function* () {
      const workspace = yield* Effect.serviceOption(Workspace);
      const env = envOf(Option.isSome(workspace) ? workspace.value : undefined);
      return yield* spawnEffect(cmd, cwd, env);
    }),
  );

/** Run and throw on failure, for actions where the user should see what broke. The thrown
 * `CliError`'s message is exactly what the old `throw new Error` produced. */
export const shOrThrow = (cmd: readonly string[], cwd?: string): Effect.Effect<string, CliError> =>
  Effect.flatMap(sh(cmd, cwd), (r) => {
    if (r.code === 0) return Effect.succeed(r.stdout);
    const stderr = r.stderr || r.stdout;
    // The message is what the old `throw new Error` said, verbatim.
    return Effect.fail(failCli(cmd, stderr, r.code, `${cmd.join(" ")} failed: ${stderr}`));
  });
