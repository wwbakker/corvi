/** Process execution port for the Git adapter. The node layer is the only real implementation;
 * tests script it. Never runs through a shell, so arguments stay arguments.
 */
import { spawn } from "node:child_process"
import { Context, Effect, Layer, Schema } from "effect"

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  program: Schema.String,
  message: Schema.String,
  // The cause is an opaque in-process throwable that is never serialized; `Schema.Unknown`
  // preserves it exactly (on decode `Schema.Defect()` is lossy).
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandInterface {
  readonly run: (input: {
    readonly program: string
    readonly args: readonly string[]
    readonly cwd: string
  }) => Effect.Effect<CommandResult, CommandError>
}

export class Command extends Context.Service<Command, CommandInterface>()("corvi/Command") {}

/** The direct spawner, exported so a host whose process runner is already in context (the app's
 * Shell seam) can fall back to it instead of providing a second one. */
export const nodeCommand: CommandInterface = {
  run: ({ program, args, cwd }) =>
    Effect.tryPromise({
      try: () =>
        new Promise<CommandResult>((resolve, reject) => {
          const child = spawn(program, [...args], {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = ""
          let stderr = ""
          child.stdout.setEncoding("utf8")
          child.stderr.setEncoding("utf8")
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk
          })
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk
          })
          child.on("error", (cause) => reject(cause))
          child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
        }),
      catch: (cause) => new CommandError({ program, message: `could not run ${program}`, cause }),
    }),
}

export const layer = Layer.succeed(Command, nodeCommand)
