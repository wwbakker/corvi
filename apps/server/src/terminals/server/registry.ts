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

/** Which substrate owns a window. Every window is a host session now; the field remains in the
 * persisted record so older files still read. */
export type BackingKind = "host";

/** A window that currently exists, as the backings report it: the live panes are the host
 * sessions whose metadata names this window. */
export type LiveWindow = {
  readonly id: string;
  readonly kind: BackingKind;
  /** The live pane session ids, in the host's order. */
  readonly panes: readonly string[];
  readonly label?: string;
  readonly command?: string;
};

/** A window as the product remembers it. `id` is the window's own, opaque and stable for its life
 * and across a server restart; `panes` are the host sessions it holds, in order. */
export type WindowRecord = {
  readonly id: string;
  readonly kind: BackingKind;
  /** The pane session ids, in order. A pane is a host session; the window is a container. */
  readonly panes: readonly string[];
  /** The focused pane's session id. */
  readonly activePane: string;
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

type Persisted = {
  readonly version: 1;
  readonly changes: Record<string, WindowRecord[]>;
  /** Session ids the user closed, kept so a restart does not re-adopt a lingering pty. See
   * `windows.ts`; a tombstone is dropped once the host no longer reports the session alive. */
  readonly closed: string[];
};

const FILE = "terminal-windows.json";
const path = (): string => join(stateDir(), FILE);

const empty = (): Persisted => ({ version: 1, changes: {}, closed: [] });

/** Read the registry, treating anything unreadable as empty, and migrate a record written before
 * panes existed: its id was its session id, so it loads as a one-pane window whose window id is
 * that same string (which stays its id even if that pane later closes). A corrupt file is a
 * reset, not a server failure: the window labels are a convenience, never the shells themselves. */
export const read = (): Persisted => {
  try {
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as {
      version?: unknown;
      changes?: Record<string, unknown>;
      closed?: unknown;
    };
    if (parsed.version !== 1 || typeof parsed.changes !== "object" || parsed.changes === null) return empty();
    const changes: Record<string, WindowRecord[]> = {};
    for (const [changeId, records] of Object.entries(parsed.changes)) changes[changeId] = migrateRecords(records);
    const closed = Array.isArray(parsed.closed)
      ? parsed.closed.filter((id): id is string => typeof id === "string")
      : [];
    return { version: 1, changes, closed };
  } catch {
    return empty();
  }
};

/** One persisted record, with the pane fields a file from before the pivot does not have. */
export const migrateRecords = (records: unknown): WindowRecord[] => {
  if (!Array.isArray(records)) return [];
  const out: WindowRecord[] = [];
  for (const raw of records) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Partial<WindowRecord> & { readonly id?: unknown };
    if (typeof record.id !== "string") continue;
    const panes =
      Array.isArray(record.panes) && record.panes.length > 0 && record.panes.every((pane) => typeof pane === "string")
        ? [...record.panes]
        : [record.id];
    const activePane =
      typeof record.activePane === "string" && panes.includes(record.activePane) ? record.activePane : panes[0]!;
    out.push({
      id: record.id,
      kind: "host",
      panes,
      activePane,
      ...(typeof record.label === "string" ? { label: record.label } : {}),
      ...(typeof record.command === "string" ? { command: record.command } : {}),
      ...(record.keepOpen === true ? { keepOpen: true } : {}),
      ...(record.notify === true ? { notify: true } : {}),
      active: record.active === true,
      activity: record.activity === true,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    });
  }
  return out;
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

/** The session ids explicitly closed, so a restart does not re-adopt a lingering pty. */
export const closedIds = (): readonly string[] => read().closed;

/** Replace the closed ids, writing only when they changed. Caller holds the registry lock (every
 * caller already does: closes, and the sweep that prunes a tombstone once its pty is gone). */
export const saveClosed = (ids: readonly string[]): void => {
  const registry = read();
  if (registry.closed.length === ids.length && registry.closed.every((id, index) => id === ids[index])) return;
  write({ ...registry, closed: [...ids] });
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

/** Merge the persisted records with the live windows: keep a record's position, pane order, label
 * and active flags while its panes live, drop records whose panes are all gone, and append new
 * windows. The registry is authoritative for a window's **identity**, but a live pane whose
 * metadata names an existing window is adopted even when the record does not list it yet (a split
 * that crashed between opening its session and saving): otherwise that shell would be invisible
 * and immortal. A pane the user closed never reaches here — `hostLive` tombstones it, so it
 * cannot be re-adopted while its pty lingers. Pure. */
export const mergeRecords = (previous: readonly WindowRecord[], live: readonly LiveWindow[]): WindowRecord[] => {
  const remaining = new Map(live.map((window) => [window.id, window]));
  const ordered: WindowRecord[] = [];
  for (const record of previous) {
    const window = remaining.get(record.id);
    if (window === undefined) continue;
    remaining.delete(record.id);
    const livePanes = new Set(window.panes);
    const panes = [
      ...record.panes.filter((pane) => livePanes.has(pane)),
      ...window.panes.filter((pane) => !record.panes.includes(pane)),
    ];
    if (panes.length === 0) continue; // every pane is gone: the window is too
    const activePane = panes.includes(record.activePane) ? record.activePane : (panes[0] ?? "");
    ordered.push({
      ...record,
      kind: window.kind,
      panes,
      activePane,
      ...(window.label !== undefined ? { label: window.label } : {}),
      ...(window.command !== undefined ? { command: window.command } : {}),
    });
  }
  for (const window of remaining.values()) {
    const panes = [...window.panes];
    if (panes.length === 0) continue;
    ordered.push({
      id: window.id,
      kind: window.kind,
      panes,
      activePane: panes[0] ?? "",
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
