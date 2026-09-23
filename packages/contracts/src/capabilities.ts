/** The capability tags every effect the host runs may require: what a contribution sees of
 * the application, with the service interface and nothing about how it is implemented.
 *
 * The tags live in the contract so an integration package can name the services it needs
 * without importing the application; the host provides the layers
 * (`apps/server/src/integrations/services.ts`). `Shell`'s Node implementation is `@corvi/shell`, which
 * re-exports the tag for callers that want one import.
 */
import { Context, Effect } from "effect";

import type { ChangeWireDto } from "./api.ts";
import type { ResolvedDto } from "./config.ts";
import type { CliError, DecodeError, IweError } from "./errors.ts";
import { Workspace } from "./workspace.ts";

export { Workspace } from "./workspace.ts";

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

/** The answer cache: read-through with a TTL, one shared refresh per key, and prefix
 * invalidation for when an action has just made an answer wrong. The work's requirements
 * pass through untouched — the cache stores outcomes, not contexts. */
export class Cache extends Context.Tag("corvi/Cache")<Cache, {
  swr<A, E, R>(key: string, ttlMs: number, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  invalidate(prefix: string): Effect.Effect<void>;
}>() {}

/** Use the answer cache without resolving it first: `swr` reads through the capability and
 * `invalidate` drops what an action has just made wrong. Both require `Cache` — there is no
 * uncached fallback; a caller outside the host's composition provides the capability. */
export const swr = <A, E, R>(
  key: string,
  ttlMs: number,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Cache> => Effect.flatMap(Cache, (cache) => cache.swr(key, ttlMs, work));

export const invalidate = (prefix: string): Effect.Effect<void, never, Cache> =>
  Effect.flatMap(Cache, (cache) => cache.invalidate(prefix));

/** The settings in effect — the same refilled object every module holds, so a settings-page
 * save is visible without restart. Read-only by convention. */
export class Settings extends Context.Tag("corvi/Settings")<Settings, ResolvedDto>() {}

/** Say something changed, so open pages refetch through the event stream. */
export class Bus extends Context.Tag("corvi/Bus")<Bus, {
  announce(event: "changes" | "windows"): Effect.Effect<void>;
}>() {}

/** The shape of the single-writer store an integration gets for its own data about a change.
 * Exposed as its own type so the host's layer can be typed against the same contract. */
export type ExtensionStoreShape = {
  /** Replace this integration's own entry in the change's `extensions` bag, writing change.json
   * once. The returned change is the written one. */
  update(change: ChangeWireDto, data: unknown): Effect.Effect<ChangeWireDto, IweError>;
  /** Read a file under this integration's directory inside the change (`extensions/<name>/`). */
  read(change: ChangeWireDto, path: string): Effect.Effect<string, IweError>;
  /** Write a file there, creating the directory on demand. */
  write(change: ChangeWireDto, path: string, text: string): Effect.Effect<void, IweError>;
  /** The files this integration has stored under its directory, recursively, relative paths. */
  list(change: ChangeWireDto): Effect.Effect<string[], IweError>;
};

/** The single writer of an integration's own data about a committed change: its entry in the
 * `extensions` bag, and the files under `extensions/<name>/` in the change directory. The host
 * provides the layer per contribution with the integration's name bound, so an effect names a
 * file (`notes.md`) rather than itself. `change.json` and the core's own sidecars are not
 * reachable through it; paths that escape the integration's directory are rejected. */
export class ExtensionStore extends Context.Tag("corvi/ExtensionStore")<
  ExtensionStore,
  ExtensionStoreShape
>() {}

/** Read access to the change store: the change module's own read, the git checkout lookup, and
 * the one read a migration needs. An integration can find a change and where its worktree is
 * without importing a module's server half. Deliberately read-only: there is no write, complete
 * or cancel. */

/** The repository facts an integration may ask the host for: what a branch is based on, the
 * repository's default branch, and whether a branch's content already landed in a base. The host
 * implements it from its own git layer, so integrations never reach into the application. */
export class GitFacts extends Context.Tag("corvi/GitFacts")<GitFacts, {
  baseFor(change: ChangeWireDto, repo: string): Effect.Effect<string | undefined>;
  remoteDefaultBranch(repo: string): Effect.Effect<string | undefined>;
  contentInMain(repo: string, branch: string, base: string | undefined): Effect.Effect<boolean>;
}>() {}

export class Changes extends Context.Tag("corvi/Changes")<Changes, {
  /** The change with this id, or null when no change.json exists for it. */
  read(id: string): Effect.Effect<ChangeWireDto | null, DecodeError>;
  /** Where a change's checkout of `repo` is — its worktree, or the in-place repository — or
   * undefined when the change has no checkout there. `checkoutFor` never fails, and this does
   * not widen that. */
  checkout(change: ChangeWireDto, repo: string): Effect.Effect<string | undefined>;
  /** The branch this repository's work starts from: what the change chose, or the repository's
   * default branch — the remote's (`origin/HEAD`, then `origin/main`), or its own `main`/`master`
   * when there is no remote. Undefined only when there is neither. */
  base(change: ChangeWireDto, repo: string): Effect.Effect<string | undefined>;
  /** Read a legacy change-root file, by bare filename, for migrating data written before
   * `ExtensionStore` existed. The name carries no path separators and is not one of the core's
   * own change-root files (`change.json`, `completion.json`); a name that is refused,
   * absent or unreadable reads as "". This is migration access, not a general escape hatch: an
   * integration's new data goes to `ExtensionStore`. */
  readSidecar(change: ChangeWireDto, name: string): Effect.Effect<string>;
}>() {}

/** The union the host provides. An effect may require any subset — requiring less is
 * assignable to requiring the union, so handlers declare only what they use. */
export type Capabilities =
  | Workspace
  | Shell
  | Cache
  | Settings
  | Bus
  | ExtensionStore
  | Changes
  | GitFacts;

/** What an integration's *load* may require: everything but the request `Workspace`, which
 * does not exist at startup. The loader provides the default workspace alongside the services,
 * so load-time `Shell` runs with its environment. */
export type Startup = Shell | Cache | Settings | Bus;
