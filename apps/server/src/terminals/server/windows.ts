/**
 * The change's windows: the registry merged with the live host sessions and tmux windows, and the
 * mutations the routes expose.
 *
 * Interactive terminals and action runs are `host` windows (a session id in the terminal host);
 * subagents are still `tmux` windows (a tmux window id, carrying `@subagent_id`). Both are
 * presented by the same pure presenter, and the registry gives them one ordered, labelled,
 * active-flagged list per change.
 *
 * Reads rebuild the registry from the live set, so a server restart loses nothing and duplicates
 * nothing: the host kept the sessions and their `{change, window}` metadata, tmux kept the
 * subagent windows, and the persisted labels/order/active sit on top.
 */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { Effect } from "effect";

import type { CommandFailure } from "@corvi/terminals/tmux";
import type { TmuxWindow } from "../../integrations/types.ts";
import { env } from "@corvi/configuration/node";
import { childEnv } from "../../capabilities/env.ts";
import { changeDir, readChange } from "../../change/server/index.ts";
import { hostClient, hostRunning, type SessionInfo } from "./host.ts";
import { paneOptions, presentWindow, type PresentedWindow } from "./presenter.ts";
import { changes as registryChanges, rebuild, save, type LiveWindow, type WindowRecord } from "./registry.ts";
import { rawAllWindows, rawWindows } from "./tmux.ts";

const asFailure = (error: unknown): CommandFailure => ({
  message: error instanceof Error ? error.message : String(error),
  stderr: "",
  exitCode: 1,
});

/** The shell a new window runs: the user's own, or `/bin/sh` when the server has none. */
const shell = (): string => process.env.SHELL ?? "/bin/sh";

const windowId = (): string => `w-${randomBytes(5).toString("hex")}`;

/** The change's context for a host window, scrubbed the same way the tmux panes were. */
const changeEnv = (changeId: string, dir: string): Record<string, string> =>
  childEnv(process.env, { [env("CHANGE_ID")]: changeId, [env("CHANGE_DIR")]: dir });

const dirOf = async (changeId: string): Promise<string> => {
  const change = await Effect.runPromise(Effect.catchAll(readChange(changeId), () => Effect.succeed(null)));
  return change === null ? process.cwd() : changeDir(change);
};

/** The host sessions for a change, alive and carrying its metadata. A host that is not running
 * has no sessions; it is not started just to be asked. */
const hostLive = async (changeId: string): Promise<{ live: LiveWindow[]; sessions: Map<string, SessionInfo> }> => {
  if (!hostRunning()) return { live: [], sessions: new Map() };
  const client = await hostClient();
  const sessions = await client.list();
  const live: LiveWindow[] = [];
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    if (!session.alive || session.metadata?.change !== changeId) continue;
    live.push({ id: session.id, kind: "host" });
    byId.set(session.id, session);
  }
  return { live, sessions: byId };
};

/** The tmux windows for a change that carry a subagent id. */
const tmuxLive = async (changeId: string): Promise<{ live: LiveWindow[]; raw: Map<string, TmuxWindow> }> => {
  const windows = await Effect.runPromise(Effect.catchAll(rawWindows(changeId, paneOptions()), () => Effect.succeed([])));
  const live: LiveWindow[] = [];
  const raw = new Map<string, TmuxWindow>();
  for (const window of windows) {
    if (!window.options["@subagent_id"]) continue;
    live.push({ id: window.id, kind: "tmux", label: window.name, command: window.command });
    raw.set(window.id, window);
  }
  return { live, raw };
};

const liveFor = async (changeId: string): Promise<{ live: LiveWindow[]; host: Map<string, SessionInfo>; tmux: Map<string, TmuxWindow> }> => {
  const host = await hostLive(changeId);
  const tmux = await tmuxLive(changeId);
  return { live: [...host.live, ...tmux.live], host: host.sessions, tmux: tmux.raw };
};

/** The raw window a host session presents as. Its process is unknown to the host, so the record's
 * command (set by an action run) or a shell is the honest answer. */
const hostRaw = (record: WindowRecord, dir: string): TmuxWindow => ({
  index: 0,
  id: record.id,
  name: record.label ?? basename(dir),
  command: record.command ?? "sh",
  active: record.active,
  activity: record.activity,
  directory: basename(dir),
  named: true,
  options: {},
});

/** The change's windows, presented. Rebuilds and persists the registry as a side effect. */
export const listWindowsAsync = async (changeId: string): Promise<PresentedWindow[]> => {
  const dir = await dirOf(changeId);
  const { live, tmux } = await liveFor(changeId);
  const records = rebuild(changeId, live);
  return records.map((record, index) => {
    const source = tmux.get(record.id) ?? hostRaw(record, dir);
    return presentWindow({ ...source, index });
  });
};

/** Every change's windows, in the one call the navigation column asks for. */
export const allWindowsAsync = async (): Promise<Record<string, PresentedWindow[]>> => {
  const sessions = hostRunning() ? await (await hostClient()).list() : [];
  const ids = new Set<string>(registryChanges());
  for (const session of sessions) if (session.alive && session.metadata?.change) ids.add(session.metadata.change);
  const tmux = await Effect.runPromise(Effect.catchAll(rawAllWindows(paneOptions()), () => Effect.succeed({})));
  for (const id of Object.keys(tmux)) ids.add(id);
  const result: Record<string, PresentedWindow[]> = {};
  for (const id of ids) result[id] = await listWindowsAsync(id);
  return result;
};

/** Rebuild, mark `id` active, and persist. */
const activate = async (changeId: string, id: string, extra: Pick<WindowRecord, "command" | "label"> = {}): Promise<WindowRecord[]> => {
  const { live } = await liveFor(changeId);
  const records = rebuild(changeId, live);
  return save(
    changeId,
    records.map((record) => (record.id === id ? { ...record, active: true, activity: false, ...extra } : { ...record, active: false })),
  );
};

/** Open a host window running `command` (or a shell) and make it the active one. */
const openHostWindow = async (
  changeId: string,
  dir: string,
  command: readonly string[],
  size: { readonly cols: number; readonly rows: number },
  extra: Pick<WindowRecord, "command" | "label"> = {},
): Promise<string> => {
  const client = await hostClient();
  const id = windowId();
  await client.open(id, {
    cwd: dir,
    command: [...command],
    cols: size.cols,
    rows: size.rows,
    env: changeEnv(changeId, dir),
    metadata: { change: changeId, window: id },
  });
  await activate(changeId, id, extra);
  return id;
};

/** A new interactive shell window. Returns the new record. */
export const newWindowAsync = async (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number } = { cols: 80, rows: 24 },
): Promise<WindowRecord> => {
  const id = await openHostWindow(changeId, dir, [shell()], size);
  const records = await listRecords(changeId);
  return records.find((record) => record.id === id)!;
};

/** A host window running one command — the window a command action gets. Returns its id. */
export const newWindowRunningAsync = async (
  changeId: string,
  dir: string,
  command: string,
  options: { readonly cwd?: string; readonly announce?: { readonly label: string } },
): Promise<string> =>
  openHostWindow(
    changeId,
    options.cwd ?? dir,
    [shell(), "-c", command],
    { cols: 100, rows: 30 },
    { command, ...(options.announce?.label ? { label: options.announce.label } : {}) },
  );

const listRecords = async (changeId: string): Promise<WindowRecord[]> => {
  const { live } = await liveFor(changeId);
  return rebuild(changeId, live);
};

export const selectWindowAsync = async (changeId: string, index: number): Promise<void> => {
  const records = await listRecords(changeId);
  if (index < 0 || index >= records.length) return;
  save(
    changeId,
    records.map((record, at) => ({ ...record, active: at === index, activity: at === index ? false : record.activity })),
  );
};

export const moveWindowAsync = async (changeId: string, from: number, to: number): Promise<void> => {
  const records = [...(await listRecords(changeId))];
  if (from < 0 || from >= records.length || to < 0 || to >= records.length || from === to) return;
  const [moved] = records.splice(from, 1);
  if (moved !== undefined) records.splice(to, 0, moved);
  save(changeId, records);
};

/** The host session the change's socket attaches to: the active host window, or a new one. */
export const ensureActiveHostWindow = async (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number },
): Promise<string> => {
  const records = await listRecords(changeId);
  const active = records.find((record) => record.active && record.kind === "host") ?? records.find((record) => record.kind === "host");
  if (active !== undefined) return active.id;
  return openHostWindow(changeId, dir, [shell()], size);
};

/** Write raw bytes to a host window's pty. */
export const writeToHostWindow = async (sessionId: string, data: string): Promise<boolean> => {
  const client = await hostClient();
  return client.write(sessionId, data);
};

export const hostWindowExists = async (sessionId: string): Promise<boolean> => {
  const client = await hostClient();
  const session = (await client.list()).find((entry) => entry.id === sessionId);
  return session !== undefined && session.alive;
};

// --- Effect wrappers for the routes --------------------------------------------------------------

export const listWindows = (changeId: string): Effect.Effect<PresentedWindow[], CommandFailure> =>
  Effect.tryPromise({ try: () => listWindowsAsync(changeId), catch: asFailure });

export const allWindows = (): Effect.Effect<Record<string, PresentedWindow[]>, CommandFailure> =>
  Effect.tryPromise({ try: () => allWindowsAsync(), catch: asFailure });

export const newWindow = (changeId: string, dir: string): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({ try: async () => void (await newWindowAsync(changeId, dir)), catch: asFailure });

export const selectWindow = (changeId: string, index: number): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({ try: () => selectWindowAsync(changeId, index), catch: asFailure });

export const moveWindow = (changeId: string, from: number, to: number): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({ try: () => moveWindowAsync(changeId, from, to), catch: asFailure });
