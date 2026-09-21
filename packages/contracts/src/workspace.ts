import { Context } from "effect";

import type { WorkspaceDto } from "./config.ts";

/**
 * Which workspace the work in hand belongs to, for the length of one request. The tag carries
 * the workspace as the contract states it (`@corvi/contracts/config`); the configuration
 * package's richer type is structurally the same.
 *
 * Routes provide it with `Effect.provideService`; modules that may run outside a request scope
 * read it with `Effect.serviceOption` and fall back to no workspace, hence an empty env
 * override (the app's `src/capabilities/shell.ts`).
 */
export class Workspace extends Context.Tag("corvi/Workspace")<Workspace, WorkspaceDto>() {}
