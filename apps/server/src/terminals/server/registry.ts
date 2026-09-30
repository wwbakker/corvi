/**
 * The window registry: the product's ordered windows for a change, persisted across a server
 * restart.
 *
 * The registry is the product's, not the substrate's: a window's order, label and active flag
 * outlive the host process that backs it. The live set is rebuilt on every read by merging the
 * persisted records with the windows the host sessions actually have (sessions whose metadata
 * names this change). A persisted record whose backing is gone is dropped; a live backing with no
 * record is appended. That is what makes a restart lossless and non-duplicating.
 *
 * `mergeRecords` is pure and unit-tested; `rebuild`/`save` are the only I/O.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "@corvi/configuration/node";

/** Which substrate owns a window: a host session (interactive terminals and action runs) or a
 * tmux window (subagents, until their slice moves them). */
export type BackingKind = "host" | "tmux";

/** A window that currently exists, as the backings report it. */
export type LiveWindow = {
  readonly id: string;
  readonly kind: BackingKind;
  readonly label?: string;
  readonly command?: string;
};

/** A window as the product remembers it. `id` is the backing's id, which is stable for the life
 * of the backing and across a server restart. */
export type WindowRecord = {
  readonly id: string;
  readonly kind: BackingKind;
  readonly label?: string;
  readonly command?: string;
  /** A command window that stays after it ends (`keepOpen` or `notify`), so its frozen last
   * output and exit state are shown rather than the window vanishing. */
  readonly keepOpen?: boolean;
  /** Whether the end of a kept window wants the user (the notification edge). */
  readonly notify?: boolean;
  readonly active: boolean;
  readonly activity: boolean;
  readonly createdAt: string;
};

type Persisted = { readonly version: 1; readonly changes: Record<string, WindowRecord[]> };

const FILE = "terminal-windows.json";
const path = (): string => join(stateDir(), FILE);

const empty = (): Persisted => ({ version: 1, changes: {} });

/** Read the registry, treating anything unreadable as empty. A corrupt file is a reset, not a
 * server failure: the window labels are a convenience, never the shells themselves. */
export const read = (): Persisted => {
  try {
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as Partial<Persisted>;
    if (parsed.version !== 1 || typeof parsed.changes !== "object" || parsed.changes === null) return empty();
    return { version: 1, changes: parsed.changes };
  } catch {
    return empty();
  }
};

const write = (registry: Persisted): void => {
  mkdirSync(dirname(path()), { recursive: true });
  const tmp = `${path()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry));
  renameSync(tmp, path());
};

const same = (left: readonly WindowRecord[], right: readonly WindowRecord[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Write only when the change's records actually changed. The watcher polls every 1.5 s; a rebuild
 * that rewrote the file on every tick would fight concurrent mutations. */
const writeIfChanged = (registry: Persisted, changeId: string, next: readonly WindowRecord[]): void => {
  if (same(registry.changes[changeId] ?? [], next)) return;
  registry.changes[changeId] = [...next];
  write(registry);
};

/** Serialize registry read-modify-writes in this process, so a poll's rebuild cannot clobber a
 * route's mutation (or two mutations each other). Non-reentrant: only wrap top-level operations. */
let queue: Promise<unknown> = Promise.resolve();
export const withRegistryLock = <T>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/** Merge the persisted records with the live windows: keep a record's position, label and active
 * flag while its backing lives, drop records whose backing is gone, append new backings. Pure. */
export const mergeRecords = (previous: readonly WindowRecord[], live: readonly LiveWindow[]): WindowRecord[] => {
  const remaining = new Map(live.map((window) => [window.id, window]));
  const ordered: WindowRecord[] = [];
  for (const record of previous) {
    const window = remaining.get(record.id);
    if (window === undefined) continue;
    remaining.delete(record.id);
    ordered.push({
      ...record,
      kind: window.kind,
      ...(window.label !== undefined ? { label: window.label } : {}),
      ...(window.command !== undefined ? { command: window.command } : {}),
    });
  }
  for (const window of remaining.values()) {
    ordered.push({
      id: window.id,
      kind: window.kind,
      ...(window.label !== undefined ? { label: window.label } : {}),
      ...(window.command !== undefined ? { command: window.command } : {}),
      active: false,
      activity: false,
      createdAt: new Date().toISOString(),
    });
  }
  if (ordered.length > 0 && !ordered.some((record) => record.active)) {
    ordered[0] = { ...ordered[0]!, active: true };
  }
  return ordered;
};

/** The change's records, rebuilt against the live windows and persisted when they changed. */
export const rebuild = (changeId: string, live: readonly LiveWindow[]): WindowRecord[] => {
  const registry = read();
  const merged = mergeRecords(registry.changes[changeId] ?? [], live);
  writeIfChanged(registry, changeId, merged);
  return merged;
};

/** Replace a change's records (after a mutation) and persist them when they changed. */
export const save = (changeId: string, records: readonly WindowRecord[]): WindowRecord[] => {
  const registry = read();
  writeIfChanged(registry, changeId, records);
  return [...records];
};

/** Forget a change's windows (a completed or cancelled change). */
export const remove = (changeId: string): void => {
  const registry = read();
  if (registry.changes[changeId] === undefined) return;
  delete registry.changes[changeId];
  write(registry);
};

/** Drop registry entries for changes that no longer exist, so the file does not grow with every
 * change id ever recorded. */
export const prune = (keep: ReadonlySet<string>): void => {
  const registry = read();
  let changed = false;
  for (const id of Object.keys(registry.changes)) {
    if (keep.has(id)) continue;
    delete registry.changes[id];
    changed = true;
  }
  if (changed) write(registry);
};

/** The persisted records for one change. */
export const records = (changeId: string): WindowRecord[] => read().changes[changeId] ?? [];

/** The change ids the registry knows about, so an empty change still lists. */
export const changes = (): string[] => Object.keys(read().changes);
