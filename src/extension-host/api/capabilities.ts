import { Context, Effect } from "effect";
import { Shell, Workspace as WorkspaceTag } from "../../capabilities/effect/tags.ts";
import type { Config } from "../../domain/config.ts";
import type { Change } from "../../domain/change.ts";
import type { DecodeError, IweError } from "../../capabilities/effect/errors.ts";

// --- Capabilities: what the host provides to every contributed effect ---------------------

/** The request's workspace — the same tag the core's routes provide (src/capabilities/effect/tags.ts).
 * Re-exported so the contract stays the one import an extension needs. */
export { Shell, WorkspaceTag as Workspace };

/** One CLI call's outcome: exit codes are data — callers branch on `code`; the typed failure
 * is reserved for a timeout, which kills the child (src/capabilities/shell.ts). */
export type { Result } from "../../capabilities/shell.ts";

/** The answer cache: read-through with a TTL, one shared refresh per key, and prefix
 * invalidation for when an action has just made an answer wrong. The work's requirements
 * pass through untouched — the cache stores outcomes, not contexts. */
export class Cache extends Context.Tag("corvi/Cache")<Cache, {
  swr<A, E, R>(key: string, ttlMs: number, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  invalidate(prefix: string): Effect.Effect<void>;
}>() {}

/** The settings in effect — the same refilled object every module holds, so a settings-page
 * save is visible without restart. Read-only by convention. */
export class Settings extends Context.Tag("corvi/Settings")<Settings, Config>() {}

/** Say something changed, so open pages refetch through the event stream. */
export class Bus extends Context.Tag("corvi/Bus")<Bus, {
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
export class ExtensionStore extends Context.Tag("corvi/ExtensionStore")<
  ExtensionStore,
  ExtensionStoreShape
>() {}

/** Read access to the change store: the change module's own read, the git checkout lookup, and
 * the one read a migration needs. An extension can find a change and where its worktree is
 * without importing a module's server half. Deliberately read-only: there is no write, complete
 * or cancel. */
export class Changes extends Context.Tag("corvi/Changes")<Changes, {
  /** The change with this id, or null when no change.json exists for it. */
  read(id: string): Effect.Effect<Change | null, DecodeError>;
  /** Where a change's checkout of `repo` is — its worktree, or the in-place repository — or
   * undefined when the change has no checkout there. `checkoutFor` never fails, and this does
   * not widen that. */
  checkout(change: Change, repo: string): Effect.Effect<string | undefined>;
  /** The branch this repository's work starts from: what the change chose, or the remote's
   * default (`origin/HEAD`, then `origin/main`), or undefined for a repository without a remote.
   * The review tab needs it to count the commits a never-pushed branch holds. */
  base(change: Change, repo: string): Effect.Effect<string | undefined>;
  /** Read a legacy change-root file, by bare filename, for migrating data written before
   * `ExtensionStore` existed. The name carries no path separators and is not one of the core's
   * own change-root files (`change.json`, `wt.toml`, `completion.json`); a name that is refused,
   * absent or unreadable reads as "". This is migration access, not a general escape hatch: an
   * extension's new data goes to `ExtensionStore` (docs/guides/extensions.md, "Data on a
   * change"). */
  readSidecar(change: Change, name: string): Effect.Effect<string>;
}>() {}

/** The union the host provides. An effect may require any subset — requiring less is
 * assignable to requiring the union, so handlers declare only what they use. */
export type Capabilities = WorkspaceTag | Shell | Cache | Settings | Bus | ExtensionStore | Changes;

/** What a `change:creating` hook may require: the request's workspace and the four services,
 * but not `ExtensionStore` — the change directory does not exist while the hooks are still
 * deciding what the change is, so a creator that needs files writes them in `change:created`. */
export type CreatingCapabilities = WorkspaceTag | Shell | Cache | Settings | Bus;

/** What an extension's *load* may require: everything but the request `Workspace`, which does
 * not exist at startup. The loader provides the default workspace alongside the services, so
 * load-time `Shell` runs with its environment. */
export type Startup = Shell | Cache | Settings | Bus;
