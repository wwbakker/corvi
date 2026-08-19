import { useState } from "react";

/**
 * Widget data kept outside React, so leaving a change and coming back shows what was there
 * instead of reloading everything. Cards still refresh in the background, so the cache only
 * decides what you look at during the first second, never what is true.
 *
 * Lives for the lifetime of the tab: a reload starts empty, which is the honest default.
 */
const store = new Map<string, unknown>();

/** State that starts from the cache and writes back to it on every update. */
export function useCached<T>(key: string): [T | undefined, (value: T) => void] {
  const [value, setValue] = useState<T | undefined>(() => store.get(key) as T | undefined);
  return [
    value,
    (next: T) => {
      store.set(key, next);
      setValue(next);
    },
  ];
}

/** Same, for the per-repository maps: one key per repository keeps them independent. */
export function cached<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function putCached<T>(key: string, value: T): void {
  store.set(key, value);
}
