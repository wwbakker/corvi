/**
 * The window registry: the product's ordered windows for a change, persisted across a server
 * restart.
 *
 * The registry is the product's, not the substrate's: a window's order, label and active flag
 * outlive the host process or tmux window that backs it. The live set is rebuilt on every read by
 * merging the persisted records with the windows the backings actually have (`host` sessions
 * whose metadata names this change, `tmux` windows carrying a `@subagent_id`). A persisted record
 * whose backing is gone is dropped; a live backing with no record is appended. That is what makes
 * a restart lossless and non-duplicating.
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

/** The change's records, rebuilt against the live windows and persisted. */
export const rebuild = (changeId: string, live: readonly LiveWindow[]): WindowRecord[] => {
  const registry = read();
  const merged = mergeRecords(registry.changes[changeId] ?? [], live);
  registry.changes[changeId] = merged;
  write(registry);
  return merged;
};

/** Replace a change's records (after a mutation) and persist them. */
export const save = (changeId: string, records: readonly WindowRecord[]): WindowRecord[] => {
  const registry = read();
  registry.changes[changeId] = [...records];
  write(registry);
  return [...records];
};

/** The change ids the registry knows about, so an empty change still lists. */
export const changes = (): string[] => Object.keys(read().changes);
