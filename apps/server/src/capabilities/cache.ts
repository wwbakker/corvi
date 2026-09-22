/**
 * Server-side cache: what the dashboard shows, kept between requests.
 *
 * Everything on a page that costs something — `gh`, `az`, a Jira query — is asked for again by the
 * overview, the dashboard and the summaries within seconds of each other. This is
 * stale-while-revalidate: an answer that is old enough to doubt is still handed over at once,
 * and a refresh runs behind it, so a page paints from what was true a moment ago rather than
 * waiting for what is true now.
 *
 * Two rules keep that honest, and they belong in the code rather than in a comment:
 *
 * - **Decisions do not read this.** `completionOf`, `mergeReadiness` and the merge itself always
 *   run live: a pull request that was approved ninety seconds ago is not a merge.
 * - **A failed refresh keeps the last good value.** A Jira that is down means "no news", not
 *   "no data".
 */

import { join } from "node:path";
import { cacheDir, env } from "@corvi/configuration/node";
import { mkdir } from "node:fs/promises";
import { Clock, Deferred, Effect, Exit, pipe } from "effect";
import { fs } from "./effect/support.ts";
import { file, write } from "./files.ts";

type Entry = {
  /** When the value was produced. */
  at: number;
  value: unknown;
  /** A refresh in flight, shared by everyone who asks meanwhile. */
  work?: Deferred.Deferred<unknown, unknown>;
};

/** One cache: its own keys, its own file, its own lifetime. Constructed by the composition that
 * owns it (the server today keeps the default below; the runtime-ownership work moves it into a
 * Layer instance). */
export interface CacheStore {
  /** The cached value, refreshed when older than `ttl`: the first call for a key waits for the
   * work; every later one is instant, and pays only for a background refresh. Concurrent callers
   * share one run rather than starting several. */
  readonly swr: <T, E, R>(
    key: string,
    ttl: number,
    work: Effect.Effect<T, E, R>,
  ) => Effect.Effect<T, E, R>;
  /** Milliseconds since this key was last produced; undefined when it was never asked for. */
  readonly ageOf: (key: string) => number | undefined;
  /** Forget everything under a prefix, for when an action has just made it wrong. */
  readonly invalidate: (prefix: string) => void;
  /** Forget everything; tests use it so one cannot pass on another's leftovers. */
  readonly clear: () => void;
  /** Restore what a previous run saved, minus anything too old to trust. */
  readonly load: () => Effect.Effect<number>;
  /** Write the cache out; a refresh in flight and a Map value are skipped. */
  readonly save: () => Effect.Effect<void>;
}

export const createCache = (): CacheStore => {
  const store = new Map<string, Entry>();

  /** The single-flight refresh: whoever asks first runs the work, everyone who arrives while it
   * runs awaits the same Deferred. A failure puts back what was there before — a CLI that fails
   * is news about the CLI, not about the work. */
  const refresh = <T, E, R>(key: string, work: Effect.Effect<T, E, R>): Effect.Effect<T, E, R> =>
    Effect.gen(function* () {
      const found = store.get(key);
      if (found?.work) {
        // One refresh per key, shared.
        return yield* Deferred.await<T, E>(found.work as unknown as Deferred.Deferred<T, E>);
      }

      const inFlight = yield* Deferred.make<T, E>();
      store.set(key, {
        at: found?.at ?? 0,
        value: found?.value,
        work: inFlight as unknown as Deferred.Deferred<unknown, unknown>,
      });
      const outcome = yield* Effect.exit(work);
      if (Exit.isSuccess(outcome)) {
        store.set(key, { at: yield* Clock.currentTimeMillis, value: outcome.value });
        // Everyone who joined mid-flight gets the same answer.
        yield* Deferred.done(inFlight, outcome);
        return outcome.value;
      }
      // Keep what we had; with nothing to fall back on, the entry is gone and the failure is the
      // answer.
      if (found) store.set(key, { at: found.at, value: found.value });
      else store.delete(key);
      // Everyone who joined mid-flight gets the same failure.
      yield* Deferred.done(inFlight, outcome);
      return yield* Effect.failCause(outcome.cause);
    });

  const swr = <T, E, R>(
    key: string,
    ttl: number,
    work: Effect.Effect<T, E, R>,
  ): Effect.Effect<T, E, R> =>
    Effect.gen(function* () {
      const found = store.get(key);

      // Nothing to serve yet — never asked, or a first run still in flight — so this one waits.
      // `at === 0` is that first run: the entry exists only to hold the shared Deferred.
      if (!found || found.at === 0) return yield* refresh(key, work);

      // Time comes from Effect's `Clock`, not the wall clock, so a test can drive staleness
      // without sleeping. Under the default clock this is `Date.now()`.
      if ((yield* Clock.currentTimeMillis) - found.at >= ttl) {
        // Stale: hand over what we had and let the refresh run behind it, on a fiber of its own —
        // a daemon, so it outlives this request. `Effect.exit` makes the fiber infallible: the
        // refresh's failure is news about the CLI, not about the page, and never reaches the
        // value served here.
        yield* Effect.forkDaemon(Effect.exit(refresh(key, work)));
      }
      return found.value as T;
    });

  /** Milliseconds since this key was last produced; undefined when it was never asked for.
   * Meant for showing how old an answer is, which is what makes serving stale data honest. */
  // Synchronous by contract — a read of the cache's own state; there is no async work for an
  // Effect to wrap. It therefore stays on the wall clock: only the staleness *decisions* read
  // Effect's `Clock`, so a TestClock can drive them; a human reading an age wants real elapsed
  // time.
  const ageOf = (key: string): number | undefined => {
    const found = store.get(key);
    return found ? Date.now() - found.at : undefined;
  };

  // Synchronous by contract (callers fire-and-forget it mid-request); nothing for an Effect to
  // wrap.
  const invalidate = (prefix: string): void => {
    for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
  };

  // Synchronous by contract: beforeEach in the tests calls it without await.
  const clear = (): void => {
    store.clear();
  };

  /*
   * Across restarts as well, because restarting is normal: `bun --hot` keeps module state, but a
   * real restart would otherwise blank every page for the six seconds it takes the CLIs to answer.
   * What is loaded from disk is stale by definition — it refreshes on the first request that wants
   * it, which is exactly what stale-while-revalidate is for.
   */

  const cacheFile = (): string => process.env[env("CACHE")] ?? join(cacheDir(), "state.json");

  /** Older than this and it is not worth restoring: a page painted from yesterday's builds is
   * worse than a page that waits. */
  const RESTORE_MAX_AGE = 6 * 60 * 60_000;

  /** Restores what a previous run saved, minus anything too old to trust. */
  const load = (): Effect.Effect<number> =>
    Effect.gen(function* () {
      type Stored = Record<string, { at: number; value: unknown }>;
      const stored = yield* pipe(
        fs<Stored>(() => file(cacheFile()).json()),
        // A missing or unreadable cache file is a cold cache, not an error.
        Effect.catchAllDefect(() => Effect.succeed(null as Stored | null)),
      );
      if (!stored) return 0;
      let restored = 0;
      // The same `Clock` as the freshness check, so restore aging is controllable in tests too.
      const now = yield* Clock.currentTimeMillis;
      for (const [key, entry] of Object.entries(stored)) {
        if (now - entry.at > RESTORE_MAX_AGE) continue;
        store.set(key, { at: entry.at, value: entry.value });
        restored++;
      }
      return restored;
    });

  /** Writes the cache out. A refresh in flight has nothing to save yet, and Maps do not survive
   * JSON — both are skipped. */
  const save = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const plain: Record<string, { at: number; value: unknown }> = {};
      for (const [key, entry] of store.entries()) {
        if (entry.at === 0 || entry.value instanceof Map) continue;
        plain[key] = { at: entry.at, value: entry.value };
      }
      yield* fs(() => mkdir(join(cacheFile(), ".."), { recursive: true }).then(() => undefined));
      yield* fs(() => write(cacheFile(), JSON.stringify(plain)).then(() => undefined));
    });

  return { swr, ageOf, invalidate, clear, load, save };
};

/** The process's default cache, the fallback for a run outside the composition root (a test or
 * a script); the server installs the cache it built with `setRuntime`. Anything that needs the
 * file or an age asks its instance for it — `loadCache`, `saveCache` and `ageOf` are instance
 * methods, not exports. */
export const defaultCache: CacheStore = createCache();

export const swr = <T, E, R>(
  key: string,
  ttl: number,
  work: Effect.Effect<T, E, R>,
): Effect.Effect<T, E, R> => defaultCache.swr(key, ttl, work);

export function invalidate(prefix: string): void {
  defaultCache.invalidate(prefix);
}

export function clearCache(): void {
  defaultCache.clear();
}
