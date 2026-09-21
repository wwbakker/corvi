import { Effect } from "effect";

import { defaultCache, type CacheStore } from "./cache.ts";
import type { Config } from "@corvi/configuration/config";
import { readConfig, reloadInto } from "../workspace/server/config.ts";

/**
 * The process's runtime: the instances the entrypoint constructs once and every request reads.
 *
 * A holder rather than a value threaded through every route while the composition root is being
 * reworked (docs/plans/architecture-refactor.md, step 4): the server installs the cache it built,
 * and the config snapshot is created on first use (or installed, as tests do) and refilled in
 * place by the settings write. The next step is for routes to be built from the runtime instead
 * of reaching for it.
 */
export type Runtime = {
  readonly cache: CacheStore;
  readonly config: Config;
};

let current: Runtime | undefined;

/** The runtime, constructed on first use when the entrypoint has not installed one: a test or a
 * script gets the process default cache and the config file as written. */
const runtime = (): Runtime => (current ??= { cache: defaultCache, config: readConfig() });


/** Install (or replace parts of) the runtime. The entrypoint calls this before serving; tests
 * set and reset it around a case. */
export const setRuntime = (next: Partial<Runtime>): void => {
  current = { ...runtime(), ...next };
};

/** Drop the installed runtime; the next read constructs a fresh one. */
export const resetRuntime = (): void => {
  current = undefined;
};

/** The runtime's cache. */
export const runtimeCache = (): CacheStore => runtime().cache;

/** The runtime's config snapshot: the one object every module reads, refilled in place by the
 * settings write so references stay valid. */
export const runtimeConfig = (): Config => runtime().config;

/** Refill the snapshot from the file. Sync, because the settings write path is synchronous and
 * the object identity must not change. */
export const reloadConfigSync = (): Config => reloadInto(runtimeConfig());

/** The same refill as an Effect, for the settings page's Effect write path. */
export const reloadConfig: Effect.Effect<Config> = Effect.sync(reloadConfigSync);
