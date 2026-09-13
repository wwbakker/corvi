import { Duration, Effect, Either, Option } from "effect";
import { spawn as childSpawn } from "node:child_process";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { CliError } from "./effect/errors.ts";
import { Shell, Workspace } from "./effect/tags.ts";
import { DEFAULT_WORKSPACE, type Workspace as WorkspaceConfig } from "../domain/config.ts";

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
  ["git", "gh", "az", "tmux"].includes(cmd[0] ?? "")
    ? cmd.slice(0, cmd[0] === "az" ? 3 : 2).join(" ")
    : (cmd[0] ?? "");

const toolOf = (cmd: readonly string[]): string => cmd[0] ?? "";

/**
 * Seconds a CLI may run before it is killed. A hung `az` fails with a `CliError` naming the
 * command rather than hanging the server forever. `IWE_CLI_TIMEOUT=0` disables the timeout
 * entirely.
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
 * and a shell would have done it. Empty outside a request. The workspace comes from the
 * `Workspace` tag (src/capabilities/effect/tags.ts), read at run time by `sh` and by the Shell capability's
 * live layer (src/extension-host/services.ts). */
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

/** The one gate every CLI call passes through. */
const gate = Effect.runSync(Effect.makeSemaphore(LIMIT));

/** A child's output as text. Reading by iteration rather than `Readable.toWeb`: a command that
 * cannot start destroys its pipes, and the web-stream adapter throws when asked to wrap one. */
const text = async (stream: Readable | null): Promise<string> => {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
  } catch {
    // Whatever arrived before the pipe died is what there is.
  }
  return Buffer.concat(chunks).toString("utf8");
};

const spawn = (
  cmd: readonly string[],
  cwd: string | undefined,
  env: Record<string, string>,
): Effect.Effect<Result, CliError> =>
  Effect.gen(function* () {
    const started = process.env.IWE_TRACE ? Number(process.hrtime.bigint()) : 0;
    const spawned = yield* Effect.either(
      Effect.try({
        try: () => {
          const [tool, ...args] = cmd;
          if (tool === undefined) throw new Error("empty command");
          // Whose login this runs as: a workspace may point `gh`, `az` and `jira` at another account.
          // Empty outside a request.
          return childSpawn(tool, args, {
            cwd,
            env: Object.keys(env).length ? { ...process.env, ...env } : undefined,
            stdio: ["ignore", "pipe", "pipe"],
          });
        },
        catch: (e) => (e instanceof Error ? e.message : String(e)),
      }),
    );
    if (Either.isLeft(spawned)) {
      // A missing tool, or a working directory that is not there any more — a repository moved
      // or deleted out from under a change. That is a failed command, not a broken server: every
      // caller already knows what to do with a non-zero code, and none of them expect a throw.
      return { code: 127, stdout: "", stderr: spawned.left };
    }
    const proc = spawned.right;
    // A command that cannot start — not on PATH, no execute permission, a working directory
    // that is gone — emits `error` rather than exiting, and an unhandled one would take the
    // server down. 127 is what a shell says for "command not found", and every caller already
    // knows what to do with a non-zero code; the message travels as stderr.
    let spawnError = "";
    const closed = new Promise<number>((resolve) => {
      proc.once("error", (error) => {
        spawnError = error.message;
        resolve(127);
      });
      proc.once("close", (code) => resolve(code ?? 1));
    });
    const read = Effect.all([
      Effect.promise(() => text(proc.stdout)),
      Effect.promise(() => text(proc.stderr)),
      // `close`, not `exit`: it waits for the output streams too, so nothing is read after the
      // answer has been returned.
      Effect.promise(() => closed),
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
      const key = traceKey(cmd);
      const seen = trace.get(key) ?? { calls: 0, cpu: 0, wall: 0 };
      trace.set(key, {
        calls: seen.calls + 1,
        // Node cannot read a child's CPU the way Bun could; the wall time is what the numbers
        // were read for (where a refresh spends its waits).
        cpu: seen.cpu,
        wall: seen.wall + (Number(process.hrtime.bigint()) - started) / 1e6,
      });
    }
    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi([stderr, spawnError].filter(Boolean).join("\n")) };
  });

/** One CLI call with the environment given explicitly, instead of read from the request
 * scope. This is what the Shell capability (src/extension-host/services.ts) runs, so extension
 * code depends on the service and the Workspace tag. */
export const shWithEnv = (
  cmd: readonly string[],
  cwd: string | undefined,
  env: Record<string, string>,
): Effect.Effect<Result, CliError> => gate.withPermits(1)(spawn(cmd, cwd, env));

/** One CLI call, bounded by the shared semaphore: `withPermits` releases on failure and on
 * interruption, so a killed or timed-out call cannot strand the gate. Non-zero exit codes are a
 * successful `Result` — callers branch on `code`; the `CliError` channel is only for a timeout.
 *
 * A `Shell` service in context wins: delegation is what lets a test script every command the
 * core runs. The live Shell layer runs `shWithEnv` (not this), so there is no recursion. The
 * `Workspace` tag read here satisfies that Shell's own `Workspace` requirement — with the
 * default workspace when the call has none, which carries no env, exactly as the direct path.
 * With no Shell in context the call spawns directly, exactly as before, so startup and cache
 * code keep working with none. The environment comes from the `Workspace` tag at run time: the
 * request the call belongs to provides it, and outside a request (`serviceOption` is none) it
 * adds nothing. The tag is read, not required, so this stays runnable where no workspace exists. */
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
    const env = envOf(Option.isSome(workspace) ? workspace.value : undefined);
    return yield* gate.withPermits(1)(spawn(cmd, cwd, env));
  });

/** Run and throw on failure, for actions where the user should see what broke: the `CliError`
 * carries the command's stderr. */
export const shOrThrow = (cmd: readonly string[], cwd?: string): Effect.Effect<string, CliError> =>
  Effect.flatMap(sh(cmd, cwd), (r) => {
    if (r.code === 0) return Effect.succeed(r.stdout);
    const stderr = r.stderr || r.stdout;
    return Effect.fail(failCli(cmd, stderr, r.code, `${cmd.join(" ")} failed: ${stderr}`));
  });
