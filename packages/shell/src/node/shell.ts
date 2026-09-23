/** The Node implementation of the shell capability: one spawned process per call, a shared
 * concurrency gate, a timeout, and a call trace.
 *
 * The host supplies the three policies it owns: what a child's environment is (the host's
 * scrubbing rules), how many CLIs may run at once, and how long one may run. Exit codes are
 * data; only a timeout fails, and the timeout kills the child before failing.
 */
import { spawn as childSpawn } from "node:child_process";
import { Readable } from "node:stream";

import { CliError } from "@corvi/contracts/errors";
import { Duration, Effect, Either } from "effect";

import type { Result } from "../shell.ts";

/** Calls, and what they cost, when the host asks for tracing. The dashboard's cost is almost
 * entirely these processes, and which of them is expensive is not something to guess at. */
export type TraceEntry = { calls: number; cpu: number; wall: number };

export interface NodeShellOptions {
  /** Seconds one CLI may run before it is killed; zero disables the timeout. */
  readonly timeoutSeconds: () => number;
  /** How many CLIs may run at once: a dashboard asks about six repositories in parallel and
   * each asks two or three vendors, so without a bound a single refresh forks thirty
   * processes. */
  readonly parallel: number;
  /** What a child's environment is: the base the host passes (its own environment) with the
   * caller's additions applied after the host's own scrub. */
  readonly environment: (
    base: Record<string, string | undefined>,
    extra: Readonly<Record<string, string>>,
  ) => Record<string, string>;
  /** Collect per-tool call counts and wall time, when the host wants them. */
  readonly trace?: Map<string, TraceEntry>;
}

/** The port the node adapter implements: the same `run`, with the environment passed in
 * instead of read from a workspace. */
export interface NodeShellShape {
  readonly run: (
    cmd: readonly string[],
    opts?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  ) => Effect.Effect<Result, CliError>;
}

/** CLIs colour their errors even when not on a TTY; those codes would end up in the UI. */
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "").trim();

/** How a call is grouped in the trace: the tool and its subcommand, not the arguments. */
const traceKey = (cmd: readonly string[]): string =>
  ["git", "gh", "az", "tmux"].includes(cmd[0] ?? "")
    ? cmd.slice(0, cmd[0] === "az" ? 3 : 2).join(" ")
    : (cmd[0] ?? "");

const toolOf = (cmd: readonly string[]): string => cmd[0] ?? "";

const failCli = (cmd: readonly string[], stderr: string, exitCode: number, message?: string): CliError =>
  new CliError({
    tool: toolOf(cmd),
    command: cmd.join(" "),
    stderr,
    exitCode,
    message: message ?? stderr,
  });

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

export const makeNodeShell = (options: NodeShellOptions): NodeShellShape => {
  /** The one gate every CLI call passes through. */
  const gate = Effect.runSync(Effect.makeSemaphore(options.parallel));

  const spawn = (
    cmd: readonly string[],
    cwd: string | undefined,
    variables: Readonly<Record<string, string>>,
  ): Effect.Effect<Result, CliError> =>
    Effect.gen(function* () {
      const started = options.trace ? Number(process.hrtime.bigint()) : 0;
      const spawned = yield* Effect.either(
        Effect.try({
          try: () => {
            const [tool, ...args] = cmd;
            if (tool === undefined) throw new Error("empty command");
            return childSpawn(tool, args, {
              cwd,
              env: options.environment(process.env, variables),
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
      const seconds = options.timeoutSeconds();
      const killHook = Effect.onInterrupt(() => Effect.sync(() => proc.kill()));
      const guarded =
        seconds > 0
          ? read.pipe(
              killHook,
              Effect.timeout(Duration.seconds(seconds)),
              Effect.catchTag("TimeoutException", () =>
                Effect.fail(failCli(cmd, `${cmd.join(" ")} timed out after ${seconds} seconds`, 124)),
              ),
            )
          : read.pipe(killHook);
      const [stdout, stderr, code] = yield* guarded;
      if (started && options.trace) {
        const key = traceKey(cmd);
        const seen = options.trace.get(key) ?? { calls: 0, cpu: 0, wall: 0 };
        options.trace.set(key, {
          calls: seen.calls + 1,
          // Node cannot read a child's CPU the way Bun could; the wall time is what the numbers
          // were read for (where a refresh spends its waits).
          cpu: seen.cpu,
          wall: seen.wall + (Number(process.hrtime.bigint()) - started) / 1e6,
        });
      }
      return {
        code,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi([stderr, spawnError].filter(Boolean).join("\n")),
      };
    });

  return {
    run: (cmd, opts) => gate.withPermits(1)(spawn(cmd, opts?.cwd, opts?.env ?? {})),
  };
};
