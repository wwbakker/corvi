import { Context } from "effect";
import type { Workspace as WorkspaceConfig } from "../config.ts";

/**
 * Which workspace the work in hand belongs to, for the length of one request. The tag carries
 * the workspace config object itself (the `Workspace` type in config.ts).
 *
 * Routes provide it with Effect.provideService; modules that may run outside a request scope
 * read it with Effect.serviceOption and fall back to exactly the old behavior: undefined
 * workspace, empty env override (src/sh.ts).
 */
export class Workspace extends Context.Tag("iwe/Workspace")<Workspace, WorkspaceConfig>() {}
