import { Context, Effect } from "effect";
import { Shell, Workspace as WorkspaceTag } from "../../platform/effect/tags.ts";
import type { Config } from "../../domain/config.ts";
import type { Change } from "../../domain/change.ts";
import type { IweError } from "../../platform/effect/errors.ts";

// --- Capabilities: what the host provides to every contributed effect ---------------------

/** The request's workspace — the same tag the core's routes provide (src/core/platform/effect/tags.ts).
 * Re-exported so the contract stays the one import an extension needs. */
export { Shell, WorkspaceTag as Workspace };

/** One CLI call's outcome: exit codes are data — callers branch on `code`; the typed failure
 * is reserved for a timeout, which kills the child (src/core/platform/capabilities/sh.ts). */
export type { Result } from "../../platform/capabilities/sh.ts";

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

/** The shape of the single-writer store an extension gets for its own data about a change.
 * Exposed as its own type so the host's layer can be typed against the same contract. */
export type ExtensionStoreShape = {
  /** Replace this extension's own entry in the change's `extensions` bag, writing change.json
   * once. The returned change is the written one. */
  update(change: Change, data: unknown): Effect.Effect<Change, IweError>;
  /** Read a file under this extension's directory inside the change (`extensions/<name>/`). */
  read(change: Change, path: string): Effect.Effect<string, IweError>;
  /** Write a file there, creating the directory on demand. */
  write(change: Change, path: string, text: string): Effect.Effect<void, IweError>;
  /** The files this extension has stored under its directory, recursively, relative paths. */
  list(change: Change): Effect.Effect<string[], IweError>;
};

/** The single writer of an extension's own data about a committed change: its entry in the
 * `extensions` bag, and the files under `extensions/<name>/` in the change directory. The host
 * provides the layer per contribution with the extension's name bound, so an effect names a
 * file (`notes.md`) rather than itself. `change.json`, `wt.toml` and the core's own sidecars are
 * not reachable through it; paths that escape the extension's directory are rejected. */
export class ExtensionStore extends Context.Tag("iwe/ExtensionStore")<
  ExtensionStore,
  ExtensionStoreShape
>() {}

/** The union the host provides. An effect may require any subset — requiring less is
 * assignable to requiring the union, so handlers declare only what they use. */
export type Capabilities = WorkspaceTag | Shell | Cache | Settings | Bus | ExtensionStore;

/** What an extension's *load* may require: everything but the request `Workspace`, which does
 * not exist at startup. The loader provides the default workspace alongside the services, so
 * load-time `Shell` runs with its environment. */
export type Startup = Shell | Cache | Settings | Bus;
