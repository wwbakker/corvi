import { Context, type Effect } from "effect";
import type { CliError } from "./errors.ts";
import type { Workspace as WorkspaceConfig } from "../../domain/config.ts";

/**
 * Which workspace the work in hand belongs to, for the length of one request. The tag carries
 * the workspace config object itself (the `Workspace` type in src/domain/config.ts).
 *
 * Routes provide it with Effect.provideService; modules that may run outside a request scope
 * read it with Effect.serviceOption and fall back to no workspace, hence an empty env override
 * (src/capabilities/shell.ts).
 */
export class Workspace extends Context.Tag("corvi/Workspace")<Workspace, WorkspaceConfig>() {}

/** Run a subprocess with the request workspace's environment already applied
 * (`GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_API_TOKEN`, …), through the shared semaphore
 * and the CLI timeout. `run` requires `Workspace` because the environment comes from it:
 * the host provides the tag alongside the service, so requiring both is free.
 *
 * The tag lives here, next to `Workspace`, rather than in the extension contract
 * (src/extension-host/api.ts) so `sh` can read it without importing that contract — which
 * re-exports `sh`'s own `Result`. api.ts re-exports it, so extension imports are unchanged. */
export class Shell extends Context.Tag("corvi/Shell")<Shell, {
  run(cmd: readonly string[], opts?: { cwd?: string }): Effect.Effect<
    { code: number; stdout: string; stderr: string },
    CliError,
    Workspace
  >;
}>() {}
