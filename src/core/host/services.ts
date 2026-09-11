import { Effect, Layer } from "effect";
import {
  Bus,
  Cache,
  Changes,
  ExtensionStore,
  Shell,
  Settings,
  Workspace,
  type Capabilities,
  type ExtensionStoreShape,
} from "./api.ts";
import { envOf, shWithEnv } from "../platform/capabilities/sh.ts";
import { invalidate, swr } from "../platform/capabilities/cache.ts";
import { config } from "../../workspace/server/index.ts";
import { announce } from "../platform/capabilities/events.ts";
import { BadRequestError } from "../platform/effect/errors.ts";
import {
  listExtensionFiles,
  readChange,
  readExtensionFile,
  setExtensionData,
  writeExtensionFile,
} from "../../change/server/store.ts";
import { checkoutFor } from "../integrations/git.ts";
import type { Workspace as WorkspaceShape } from "../domain/config.ts";

/**
 * The live layers behind the capabilities (src/core/host/api.ts) — host-side, not part of
 * the contract. One static layer per service; the request's workspace is provided alongside
 * them per request, so one service instance serves every request and `Shell` reads the
 * request's workspace at run time.
 */

/** `run` requires `Workspace` in its own R — the environment comes from the tag, read at
 * run time, so one Shell instance serves every request and `~` expansion stays where the
 * rest of the env handling lives (src/core/platform/capabilities/sh.ts). */
export const ShellLive = Layer.effect(
  Shell,
  Effect.succeed({
    run: (cmd, opts) =>
      Effect.flatMap(Workspace, (workspace) => shWithEnv(cmd, opts?.cwd, envOf(workspace))),
  }),
);

export const CacheLive = Layer.succeed(Cache, {
  swr: <A, E, R>(key: string, ttlMs: number, work: Effect.Effect<A, E, R>) =>
    swr(key, ttlMs, work),
  invalidate: (prefix) => Effect.sync(() => invalidate(prefix)),
});

// The same refilled object every module holds by reference: a settings-page save is visible
// through the service without restart.
export const SettingsLive = Layer.succeed(Settings, config);

export const BusLive = Layer.succeed(Bus, {
  announce: (event) => Effect.sync(() => announce(event)),
});

/** The read-only `Changes` store: the change module's own read and the git checkout lookup,
 * provided statically like the other services. It is a leaf delegation — nothing here needs a
 * workspace — and `../integrations/git.ts` is imported by value rather than its barrel so the
 * host's module graph stays acyclic. */
export const ChangesLive = Layer.succeed(Changes, {
  read: readChange,
  checkout: checkoutFor,
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
    CacheLive,
    SettingsLive,
    BusLive,
    ChangesLive,
    Layer.succeed(Workspace, workspace),
    extensionStoreLayer(extension),
  );
