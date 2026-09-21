/** The shell capability: running a subprocess with the caller's environment already applied.
 *
 * The process itself is the host's business — a native process, a scripted fake in tests — so
 * the port names only what a caller does with it. `run` requires `Workspace` because the
 * environment comes from the request's workspace: the host provides the tag alongside the
 * service, so requiring both is free.
 */
import { Context, type Effect } from "effect";

import type { CliError } from "@corvi/contracts/errors";
import type { Workspace } from "@corvi/contracts/workspace";

/** One CLI call's outcome: exit codes are data — callers branch on `code`; the typed failure
 * is reserved for a timeout, which kills the child. */
export type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Run a subprocess with the request workspace's environment already applied
 * (`GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_API_TOKEN`, …), through the shared semaphore
 * and the CLI timeout. */
export interface ShellShape {
  run(
    cmd: readonly string[],
    opts?: { readonly cwd?: string },
  ): Effect.Effect<Result, CliError, Workspace>;
}

export class Shell extends Context.Tag("corvi/Shell")<Shell, ShellShape>() {}
