import { Effect, Layer } from "effect";
import {
  Bus,
  Cache,
  Changes,
  ExtensionStore,
  Shell,
  Settings,
  Workspace,
} from "./api/capabilities.ts";
import type { Capabilities, ExtensionStoreShape } from "./api/capabilities.ts";
import { envOf, shWithEnv } from "../capabilities/shell.ts";
import { defaultCache, type CacheStore } from "../capabilities/cache.ts";
import { runtimeCache, runtimeConfig } from "../capabilities/runtime.ts";
import { announce } from "../capabilities/bus.ts";
import { BadRequestError } from "../capabilities/effect/errors.ts";
import {
  CORE_SIDECARS,
  listExtensionFiles,
  readChange,
  readExtensionFile,
  readSidecar,
  setExtensionData,
  writeExtensionFile,
} from "../change/server/store.ts";
import { baseFor, checkoutFor } from "../vendors/git.ts";
import type { Change } from "../domain/change.ts";
import type { Workspace as WorkspaceShape } from "@corvi/configuration/config";

/**
 * The live layers behind the capabilities (src/integrations/types.ts) — host-side, not part of
 * the contract. One static layer per service; the request's workspace is provided alongside
 * them per request, so one service instance serves every request and `Shell` reads the
 * request's workspace at run time.
 */

/** `run` requires `Workspace` in its own R — the environment comes from the tag, read at
 * run time, so one Shell instance serves every request and `~` expansion stays where the
 * rest of the env handling lives (src/capabilities/shell.ts). */
export const ShellLive = Layer.effect(
  Shell,
  Effect.succeed({
    run: (cmd, opts) =>
      Effect.flatMap(Workspace, (workspace) => shWithEnv(cmd, opts?.cwd, envOf(workspace))),
  }),
);

/** One cache instance, through the capability: the transport's behavior is the cache's, and
 * the instance is what the server owns (the runtime-ownership work moves this construction to
 * the entrypoint; `cacheLive(cache)` is the seam). */
export const cacheLive = (cache: CacheStore = defaultCache): Layer.Layer<Cache> =>
  Layer.succeed(Cache, {
    swr: <A, E, R>(key: string, ttlMs: number, work: Effect.Effect<A, E, R>) =>
      cache.swr(key, ttlMs, work),
    invalidate: (prefix) => Effect.sync(() => cache.invalidate(prefix)),
  });

export const CacheLive = cacheLive();

// The same refilled object every module holds by reference: a settings-page save is visible
// through the service without restart. The layer defers the read to construction, so importing
// this module does not read the config file.
export const SettingsLive = Layer.effect(
  Settings,
  Effect.sync(() => runtimeConfig()),
);

export const BusLive = Layer.succeed(Bus, {
  announce: (event) => Effect.sync(() => announce(event)),
});

/** The read-only `Changes` store: the change module's own read, the git checkout and
 * base-branch lookups, and the legacy sidecar read a migration uses. Provided statically like
 * the other services. It is a leaf delegation — nothing here needs a workspace at the type
 * level, and the git lookups reach the request's `Shell` at run time — and
 * `../vendors/git.ts` is imported by value rather than its barrel so the host's module
 * graph stays acyclic. */
export const ChangesLive = Layer.succeed(Changes, {
  read: readChange,
  checkout: checkoutFor,
  base: baseFor,
  // A legacy sidecar is a bare filename: the capability is migration access, so a name with a
  // separator — or a directory component like ".." — is not a change-root file and reads as "".
  // The store's own files (change.json, completion.json) are refused too, so the read cannot be
  // turned on the change record or the completion journal.
  readSidecar: (change: Change, name: string) =>
    name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") ||
      CORE_SIDECARS.has(name)
      ? Effect.succeed("")
      : readSidecar(change.id, name),
});

/** The `ExtensionStore` layer with the extension's name bound, so an effect writes `notes.md`
 * and lands in `extensions/<extension>/notes.md` without naming itself. The name arrives at
 * the contribution boundary (the host knows which extension it is running); a place with no
 * extension in hand still gets the capability, but its methods refuse rather than guess whose
 * bag they would be editing. Exported so the tests that assemble the capability union by hand
 * (with a scripted Shell) can include it; production goes through `capabilitiesLayer`. */
export const extensionStoreLayer = (extension: string | undefined): Layer.Layer<ExtensionStore> => {
  const unbound = <A>(): Effect.Effect<A, BadRequestError> =>
    Effect.fail(new BadRequestError({ message: "ExtensionStore has no extension in context" }));
  const store: ExtensionStoreShape = {
    update: (change, data) =>
      extension ? setExtensionData(change, extension, data) : unbound(),
    read: (change, path) =>
      extension ? readExtensionFile(change, extension, path) : unbound(),
    write: (change, path, text) =>
      extension ? writeExtensionFile(change, extension, path, text) : unbound(),
    list: (change) => (extension ? listExtensionFiles(change, extension) : unbound()),
  };
  return Layer.succeed(ExtensionStore, store);
};

/** Everything an extension's effect may ask for, provided at once: the request's workspace,
 * the four services, and the single-writer `ExtensionStore` bound to the extension whose
 * contribution is running. Contributed effects run through this, so their requirements are
 * satisfied wherever the host runs them — cards, hooks, lookups, steps, routes. */
export const capabilitiesLayer = (
  workspace: WorkspaceShape,
  extension?: string,
): Layer.Layer<Capabilities> =>
  Layer.mergeAll(
    ShellLive,
    cacheLive(runtimeCache()),
    SettingsLive,
    BusLive,
    ChangesLive,
    Layer.succeed(Workspace, workspace),
    extensionStoreLayer(extension),
  );
