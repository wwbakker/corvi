import { Context, Effect } from "effect";
import type { Option } from "effect";
import type { Workspace as WorkspaceConfig } from "../config.ts";

/**
 * Which workspace the work in hand belongs to, for the length of one request — the Effect
 * replacement for the ambient AsyncLocalStorage in src/context.ts. The tag carries the
 * workspace config object itself (the `Workspace` type in config.ts).
 *
 * Routes provide it with Effect.provideService; modules that may run outside a request scope
 * read it with Effect.serviceOption and fall back to exactly the old behavior: undefined
 * workspace, empty env override.
 */
export class Workspace extends Context.Tag("iwe/Workspace")<Workspace, WorkspaceConfig>() {}

/** The workspace when there is one; Option.none() outside a request, like currentWorkspace()'s
 * undefined used to be. */
export const workspaceOption: Effect.Effect<Option.Option<WorkspaceConfig>> =
  Effect.serviceOption(Workspace);
