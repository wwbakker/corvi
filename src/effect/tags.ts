import { Context, type Effect } from "effect";
import type { CliError } from "./errors.ts";
import type { Workspace as WorkspaceConfig } from "../config.ts";

/**
 * Which workspace the work in hand belongs to, for the length of one request. The tag carries
 * the workspace config object itself (the `Workspace` type in config.ts).
 *
 * Routes provide it with Effect.provideService; modules that may run outside a request scope
 * read it with Effect.serviceOption and fall back to no workspace, hence an empty env override
 * (src/sh.ts).
 */
export class Workspace extends Context.Tag("iwe/Workspace")<Workspace, WorkspaceConfig>() {}

/** Run a subprocess with the request workspace's environment already applied
 * (`GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_API_TOKEN`, …), through the shared semaphore
 * and the CLI timeout. `run` requires `Workspace` because the environment comes from it:
 * the host provides the tag alongside the service, so requiring both is free.
 *
 * The tag lives here, next to `Workspace`, rather than in the extension contract
 * (src/core/host/api.ts) so `sh` can read it without importing that contract — which
 * re-exports `sh`'s own `Result`. api.ts re-exports it, so extension imports are unchanged. */
export class Shell extends Context.Tag("iwe/Shell")<Shell, {
  run(cmd: readonly string[], opts?: { cwd?: string }): Effect.Effect<
    { code: number; stdout: string; stderr: string },
    CliError,
    Workspace
  >;
}>() {}
