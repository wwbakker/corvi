/** Process execution port for the Git adapter. The node layer is the only real implementation;
 * tests script it. Never runs through a shell, so arguments stay arguments.
 */
import { spawn } from "node:child_process"
import { Context, Data, Effect, Layer } from "effect"

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly program: string
  readonly message: string
  readonly cause?: unknown
}> {}

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

export class Command extends Context.Tag("corvi/Command")<Command, CommandInterface>() {}

export const layer = Layer.succeed(Command, {
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
})
