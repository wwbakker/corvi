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
 * nothing. The rebuild is skipped when tmux could not be read — a timed-out backing is not
 * evidence that its windows died, and persisting the empty result would erase labels and order.
 */
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import type { CommandFailure } from "@corvi/terminals/tmux";
import type { TmuxWindow } from "../../integrations/types.ts";
import { env } from "@corvi/configuration/node";
import { childEnv } from "../../capabilities/env.ts";
import { changeDir, listChanges, readChange } from "../../change/server/index.ts";
import { hostClient, hostRunning, type SessionInfo } from "./host.ts";
import { clearStatus, pruneStatuses, statusOf, type AgentStatus } from "./status.ts";
import { paneOptions, presentWindow, type PresentedWindow } from "./presenter.ts";
import {
  prune as pruneRegistry,
  rebuild,
  records as registryRecords,
  remove as removeRecords,
  save,
  withRegistryLock,
  type LiveWindow,
  type WindowRecord,
} from "./registry.ts";
import { rawAllWindows, rawWindows } from "./tmux.ts";

const asFailure = (error: unknown): CommandFailure => ({
  message: error instanceof Error ? error.message : String(error),
  stderr: "",
  exitCode: 1,
});

/** The shell a new window runs: the user's own, or `/bin/sh` when the server has none. */
const shell = (): string => process.env.SHELL ?? "/bin/sh";

const windowId = (): string => `w-${randomBytes(5).toString("hex")}`;

/** The checkout's own CLI entry, put in front of a host pane's PATH. An installed `corvi` from
 * another checkout may not have this channel's commands, and the server's `putCliOnPath`
 * deliberately lets an installed one win for `start`/`stop` — so a host session seeds the
 * matching entry explicitly. */
const cliBinDir = (): string => join(fileURLToPath(new URL("../../../../../", import.meta.url)), "apps", "cli", "bin");

/** The change's context for a host window. The host replaces its own environment with this one
 * (`session.open` env is the whole environment), so the scrub here actually wins. `TMUX` and
 * `TMUX_PANE` are dropped: a host session is not a tmux pane, and a reporter that inherited them
 * would write to the user's own tmux server. */
const changeEnv = (changeId: string, dir: string): Record<string, string> => {
  const child = childEnv(process.env, { [env("CHANGE_ID")]: changeId, [env("CHANGE_DIR")]: dir });
  delete child.TMUX;
  delete child.TMUX_PANE;
  const cli = cliBinDir();
  child.PATH = child.PATH === undefined ? cli : `${cli}:${child.PATH}`;
  return child;
};

const dirOf = async (changeId: string): Promise<string> => {
  const change = await Effect.runPromise(Effect.catchAll(readChange(changeId), () => Effect.succeed(null)));
  return change === null ? process.cwd() : changeDir(change);
};

/** The host sessions for a change. Alive ones, plus retained-dead ones whose record asked to be
 * kept open (a command window that froze on its output). A host that is not running has no
 * sessions; it is not started just to be asked. */
const hostLive = async (
  changeId: string,
  keep: ReadonlySet<string>,
): Promise<{ live: LiveWindow[]; sessions: Map<string, SessionInfo> }> => {
  if (!hostRunning()) return { live: [], sessions: new Map() };
  const client = await hostClient();
  const sessions = await client.list();
  const live: LiveWindow[] = [];
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    if (session.metadata?.change !== changeId) continue;
    if (!session.alive) clearStatus(session.id, session.incarnation);
    if (!session.alive && !keep.has(session.id)) continue;
    live.push({ id: session.id, kind: "host" });
    byId.set(session.id, session);
  }
  return { live, sessions: byId };
};

/** The tmux windows for a change that carry a subagent id. `ok:false` when tmux could not be
 * read; the caller must not treat that as "no windows". */
const tmuxLive = async (
  changeId: string,
): Promise<{ live: LiveWindow[]; raw: Map<string, TmuxWindow>; ok: boolean }> => {
  const result = await Effect.runPromise(Effect.either(rawWindows(changeId, paneOptions())));
  if (result._tag === "Left") return { live: [], raw: new Map(), ok: false };
  const live: LiveWindow[] = [];
  const raw = new Map<string, TmuxWindow>();
  for (const window of result.right) {
    if (!window.options["@subagent_id"]) continue;
    live.push({ id: window.id, kind: "tmux", label: window.name, command: window.command });
    raw.set(window.id, window);
  }
  return { live, raw, ok: true };
};

const liveFor = async (
  changeId: string,
  keep: ReadonlySet<string>,
): Promise<{ live: LiveWindow[]; host: Map<string, SessionInfo>; tmux: Map<string, TmuxWindow>; tmuxOk: boolean }> => {
  const host = await hostLive(changeId, keep);
  const tmux = await tmuxLive(changeId);
  return { live: [...host.live, ...tmux.live], host: host.sessions, tmux: tmux.raw, tmuxOk: tmux.ok };
};

/** The pane options a host window adds for the agent presenter: the status its reporter set,
 * through the CLI/HTTP store or the OSC parse, in the same vocabulary tmux pane options use. */
const agentOptions = (status: AgentStatus | undefined): Record<string, string> =>
  status === undefined
    ? {}
    : {
        "@agent_status": status.state,
        ...(status.name ? { "@agent_name": status.name } : {}),
        ...(status.sessionName ? { "@agent_session_name": status.sessionName } : {}),
        ...(status.message ? { "@agent_last_message": status.message } : {}),
      };

/** The pane options a host window adds for the presenter: an action window's announced label and
 * its exit state, so `commandWindowPresenter` names it and marks a finished run as wanting the
 * user. */
const commandOptions = (record: WindowRecord, session: SessionInfo | undefined): Record<string, string> => {
  if (record.label === undefined) return {};
  return {
    "@corvi_action": record.label,
    "@corvi_notify": record.notify ? "1" : "0",
    ...(session !== undefined && !session.alive ? { "@corvi_exit": String(session.exitCode ?? 0) } : {}),
  };
};

/** The raw window a host session presents as. A labelled one (an action run) uses the label as
 * its name and lets the presenter speak; a plain shell uses its directory. */
const hostRaw = (record: WindowRecord, dir: string, session: SessionInfo | undefined, status: AgentStatus | undefined): TmuxWindow => ({
  index: 0,
  id: record.id,
  name: record.label ?? basename(dir),
  command: record.label !== undefined ? "sh" : (record.command ?? "sh"),
  active: record.active,
  activity: record.activity,
  directory: basename(dir),
  named: true,
  options: { ...agentOptions(status), ...commandOptions(record, session) },
});

/** The change's windows, presented. Rebuilds and persists the registry — but only when every
 * backing could be read. */
export const listWindowsAsync = (changeId: string): Promise<PresentedWindow[]> =>
  withRegistryLock(async () => {
    const dir = await dirOf(changeId);
    const previous = registryRecords(changeId);
    const keep = new Set(previous.filter((record) => record.keepOpen).map((record) => record.id));
    const { live, host, tmux, tmuxOk } = await liveFor(changeId, keep);
    const records = tmuxOk ? rebuild(changeId, live) : previous;
    return records.map((record, index) => {
      const session = host.get(record.id);
      const stored = session === undefined ? undefined : statusOf(session.id, session.incarnation);
      // `undefined` means nothing was reported (use the host's OSC parse); `null` is an explicit
      // clear and suppresses the fallback.
      const status = stored === undefined ? session?.status : (stored ?? undefined);
      const source = tmux.get(record.id) ?? hostRaw(record, dir, session, status);
      return presentWindow({ ...source, index });
    });
  });

/** Every change's windows, in the one call the navigation column asks for. Registry entries for
 * changes that no longer exist are pruned, so the file does not grow forever. */
export const allWindowsAsync = async (): Promise<Record<string, PresentedWindow[]>> => {
  const changeList = await Effect.runPromise(Effect.catchAll(listChanges(), () => Effect.succeed([])));
  const existing = new Set(changeList.map((change) => change.id));
  pruneRegistry(existing);
  const sessions = hostRunning() ? await (await hostClient()).list() : [];
  pruneStatuses(new Set(sessions.filter((session) => session.alive).map((session) => `${session.id}#${session.incarnation}`)));
  const ids = new Set<string>(existing);
  for (const session of sessions) {
    if (session.alive && session.metadata?.change && existing.has(session.metadata.change)) ids.add(session.metadata.change);
  }
  const tmux = await Effect.runPromise(Effect.catchAll(rawAllWindows(paneOptions()), () => Effect.succeed({})));
  for (const id of Object.keys(tmux)) if (existing.has(id)) ids.add(id);
  const result: Record<string, PresentedWindow[]> = {};
  for (const id of ids) result[id] = await listWindowsAsync(id);
  return result;
};

type RecordExtra = Pick<WindowRecord, "command" | "label" | "keepOpen" | "notify">;

/** Rebuild, mark `id` active, and persist. A failed tmux read must not be treated as "every
 * tmux window died": the new host window is added to the persisted records instead of a
 * rebuild. Caller holds the registry lock. */
const activate = async (changeId: string, id: string, extra: RecordExtra = {}): Promise<WindowRecord[]> => {
  const previous = registryRecords(changeId);
  const keep = new Set(previous.filter((record) => record.keepOpen).map((record) => record.id));
  const { live, tmuxOk } = await liveFor(changeId, keep);
  const base = tmuxOk ? rebuild(changeId, live) : previous;
  const present = base.some((record) => record.id === id)
    ? base
    : [...base, { id, kind: "host" as const, active: false, activity: false, createdAt: new Date().toISOString(), ...extra }];
  return save(
    changeId,
    present.map((record) => (record.id === id ? { ...record, active: true, activity: false, ...extra } : { ...record, active: false })),
  );
};

/** Open a host window running `command` (or a shell) and make it the active one. Caller holds the
 * registry lock. */
const openHostWindow = async (
  changeId: string,
  dir: string,
  command: readonly string[],
  size: { readonly cols: number; readonly rows: number },
  extra: RecordExtra = {},
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

const listRecords = async (changeId: string): Promise<WindowRecord[]> => {
  const previous = registryRecords(changeId);
  const keep = new Set(previous.filter((record) => record.keepOpen).map((record) => record.id));
  const { live, tmuxOk } = await liveFor(changeId, keep);
  return tmuxOk ? rebuild(changeId, live) : previous;
};

/** A new interactive shell window. Returns the new record. */
export const newWindowAsync = (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number } = { cols: 80, rows: 24 },
): Promise<WindowRecord> =>
  withRegistryLock(async () => {
    const id = await openHostWindow(changeId, dir, [shell()], size);
    const records = await listRecords(changeId);
    const created = records.find((record) => record.id === id);
    if (created === undefined) throw new Error(`the new window ${id} vanished from the registry`);
    return created;
  });

/** A host window running one command — the window a command action gets. Returns its id. */
export const newWindowRunningAsync = (
  changeId: string,
  dir: string,
  command: string,
  options: { readonly cwd?: string; readonly keepOpen?: boolean; readonly announce?: { readonly label: string; readonly notify: boolean } },
): Promise<string> =>
  withRegistryLock(() =>
    openHostWindow(changeId, options.cwd ?? dir, [shell(), "-c", command], { cols: 100, rows: 30 }, {
      command,
      ...(options.announce?.label ? { label: options.announce.label } : {}),
      ...(options.keepOpen || options.announce?.notify ? { keepOpen: true } : {}),
      ...(options.announce ? { notify: options.announce.notify } : {}),
    }),
  );

export const selectWindowAsync = (changeId: string, index: number): Promise<void> =>
  withRegistryLock(async () => {
    const records = await listRecords(changeId);
    if (index < 0 || index >= records.length) return;
    save(
      changeId,
      records.map((record, at) => ({ ...record, active: at === index, activity: at === index ? false : record.activity })),
    );
  });

export const moveWindowAsync = (changeId: string, from: number, to: number): Promise<void> =>
  withRegistryLock(async () => {
    const records = [...(await listRecords(changeId))];
    if (from < 0 || from >= records.length || to < 0 || to >= records.length || from === to) return;
    const [moved] = records.splice(from, 1);
    if (moved !== undefined) records.splice(to, 0, moved);
    save(changeId, records);
  });

/** The host session the change's socket attaches to: the active host window, or a new one. */
export const ensureActiveHostWindow = (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number },
): Promise<string> =>
  withRegistryLock(async () => {
    const records = await listRecords(changeId);
    const active =
      records.find((record) => record.active && record.kind === "host") ?? records.find((record) => record.kind === "host");
    if (active !== undefined) return active.id;
    return openHostWindow(changeId, dir, [shell()], size);
  });

/** Write raw bytes to a host window's pty; `false` when the window is gone. */
export const writeToHostWindow = async (sessionId: string, data: string): Promise<boolean> => {
  const client = await hostClient();
  return client.write(sessionId, data);
};

/** Kill every host session of a change and forget its registry entry — a completed or cancelled
 * change has no terminals. */
export const stopHostTerminals = (changeId: string): Promise<void> =>
  withRegistryLock(async () => {
    if (hostRunning()) {
      const client = await hostClient();
      for (const session of await client.list()) {
        if (session.metadata?.change === changeId) await client.kill(session.id).catch(() => undefined);
      }
    }
    removeRecords(changeId);
  });

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
