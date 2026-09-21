import { Effect, Layer } from "effect";
import { Workspace } from "@corvi/contracts/workspace";
import { sh as runCli, type Result } from "../src/capabilities/shell.ts";
import { workspaceById } from "../src/workspace/server/index.ts";

/**
 * The Promise-shaped CLI helper the scripts use.
 *
 * The server's `sh` reads its environment from the request's `Workspace` tag; a script has
 * no request, so this provides the default workspace and turns a timed-out CLI into the exit-code
 * shape scripts branch on (a timed-out CLI is exit code 124). The server itself never uses this:
 * its callers run in a request.
 */
export const sh = (cmd: readonly string[], cwd?: string): Promise<Result> =>
  Effect.runPromise(
    Effect.provide(
      runCli(cmd, cwd).pipe(
        Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
      ),
      Layer.succeed(Workspace, workspaceById(undefined)),
    ),
  );
