/**
 * Server-side cache: what the dashboard shows, kept between requests.
 *
 * Everything on a page costs a subprocess — `gh`, `az`, `jira` — and the same answers are asked
 * for by the overview, the dashboard and the summaries within seconds of each other. This is
 * stale-while-revalidate: an answer that is old enough to doubt is still handed over at once,
 * and a refresh runs behind it, so a page paints from what was true a moment ago rather than
 * waiting for what is true now.
 *
 * Two rules keep that honest, and they belong in the code rather than in a comment:
 *
 * - **Decisions do not read this.** `completionOf`, `mergeReadiness` and the merge itself always
 *   run live: a pull request that was approved ninety seconds ago is not a merge.
 * - **A failed refresh keeps the old value.** A Jira that is down means "no news", not "no data".
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

type Entry = {
  /** When the value was produced. */
  at: number;
  value: unknown;
  /** A refresh in flight, shared by everyone who asks meanwhile. */
  work?: Promise<unknown>;
};

const store = new Map<string, Entry>();

/** Milliseconds since this key was last produced; undefined when it was never asked for.
 * Meant for showing how old an answer is, which is what makes serving stale data honest. */
export const ageOf = (key: string): number | undefined => {
  const found = store.get(key);
  return found ? Date.now() - found.at : undefined;
};

/**
 * The cached value, refreshed when older than `ttl`.
 *
 * The first call for a key waits for the work; every later one is instant, and pays only for a
 * background refresh. Concurrent callers share one run rather than starting several.
 */
export async function swr<T>(key: string, ttl: number, work: () => Promise<T>): Promise<T> {
  const found = store.get(key);

  // Nothing to serve yet — never asked, or a first run still in flight — so this one waits.
  // `at === 0` is that first run: the entry exists only to hold the shared promise.
  if (!found || found.at === 0) return (await refresh(key, work)) as T;

  if (Date.now() - found.at >= ttl) void refresh(key, work).catch(() => {});
  return found.value as T;
}

function refresh<T>(key: string, work: () => Promise<T>): Promise<T> {
  const found = store.get(key);
  if (found?.work) return found.work as Promise<T>; // one refresh per key, shared

  const running = work();
  store.set(key, { at: found?.at ?? 0, value: found?.value, work: running });
  return running
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((e) => {
      // Keep what we had: a CLI that fails is news about the CLI, not about the work.
      if (found) store.set(key, { at: found.at, value: found.value });
      else store.delete(key);
      throw e;
    });
}

/** Forget everything under a prefix, for when an action has just made it wrong — a pull request
 * created, a branch pushed, a change completed. */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

/** Tests share a process; a cache that outlives one of them is a test that passes by accident. */
export function clearCache(): void {
  store.clear();
}

/*
 * Across restarts as well, because restarting is normal: `bun --hot` keeps module state, but a
 * real restart would otherwise blank every page for the six seconds it takes the CLIs to answer.
 * What is loaded from disk is stale by definition — it refreshes on the first request that wants
 * it, which is exactly what stale-while-revalidate is for.
 */

const cacheFile = (): string =>
  process.env.IWE_CACHE ?? join(homedir(), ".cache", "iwe", "state.json");

/** Older than this and it is not worth restoring: a page painted from yesterday's builds is
 * worse than a page that waits. */
const RESTORE_MAX_AGE = 6 * 60 * 60_000;

export async function loadCache(): Promise<number> {
  type Stored = Record<string, { at: number; value: unknown }>;
  const stored = await Bun.file(cacheFile())
    .json()
    .then((v) => v as Stored)
    .catch(() => null);
  if (!stored) return 0;
  let restored = 0;
  for (const [key, entry] of Object.entries(stored)) {
    if (Date.now() - entry.at > RESTORE_MAX_AGE) continue;
    store.set(key, { at: entry.at, value: entry.value });
    restored++;
  }
  return restored;
}

export async function saveCache(): Promise<void> {
  const plain: Record<string, { at: number; value: unknown }> = {};
  for (const [key, entry] of store.entries()) {
    // A refresh in flight has nothing to save yet, and Maps do not survive JSON.
    if (entry.at === 0 || entry.value instanceof Map) continue;
    plain[key] = { at: entry.at, value: entry.value };
  }
  await mkdir(join(cacheFile(), ".."), { recursive: true });
  await Bun.write(cacheFile(), JSON.stringify(plain));
}
