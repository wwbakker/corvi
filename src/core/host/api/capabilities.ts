import { Context, Effect } from "effect";
import { Shell, Workspace as WorkspaceTag } from "../../../effect/tags.ts";
import type { Config } from "../../../config.ts";

// --- Capabilities: what the host provides to every contributed effect ---------------------

/** The request's workspace — the same tag the core's routes provide (src/effect/tags.ts).
 * Re-exported so the contract stays the one import an extension needs. */
export { Shell, WorkspaceTag as Workspace };

/** One CLI call's outcome: exit codes are data — callers branch on `code`; the typed failure
 * is reserved for a timeout, which kills the child (src/sh.ts). */
export type { Result } from "../../../sh.ts";

/** The answer cache: read-through with a TTL, one shared refresh per key, and prefix
 * invalidation for when an action has just made an answer wrong. The work's requirements
 * pass through untouched — the cache stores outcomes, not contexts. */
export class Cache extends Context.Tag("iwe/Cache")<Cache, {
  swr<A, E, R>(key: string, ttlMs: number, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  invalidate(prefix: string): Effect.Effect<void>;
}>() {}

/** The settings in effect — the same refilled object every module holds, so a settings-page
 * save is visible without restart. Read-only by convention. */
export class Settings extends Context.Tag("iwe/Settings")<Settings, Config>() {}

/** Say something changed, so open pages refetch through the event stream. */
export class Bus extends Context.Tag("iwe/Bus")<Bus, {
  announce(event: "changes" | "windows"): Effect.Effect<void>;
}>() {}

/** The union the host provides. An effect may require any subset — requiring less is
 * assignable to requiring the union, so handlers declare only what they use. */
export type Capabilities = WorkspaceTag | Shell | Cache | Settings | Bus;

/** What an extension's *load* may require: everything but the request `Workspace`, which does
 * not exist at startup. The loader provides the default workspace alongside the services, so
 * load-time `Shell` runs with its environment. */
export type Startup = Shell | Cache | Settings | Bus;
