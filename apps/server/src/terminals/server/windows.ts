/**
 * The change's windows: the registry merged with the live host sessions, and the mutations the
 * routes expose.
 *
 * Interactive terminals, action runs and subagents are all `host` windows (a session id in the
 * terminal host). The registry gives them one ordered, labelled, active-flagged list per change,
 * and the same pure presenter draws them.
 *
 * Reads rebuild the registry from the live set, so a server restart loses nothing and duplicates
 * nothing.
 */
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import type { CommandFailure, NewWindowOptions } from "@corvi/terminals/model";
import type { RawWindow } from "../../integrations/types.ts";
import { env, stateDir } from "@corvi/configuration/node";
import { childEnv } from "../../capabilities/env.ts";
import { changeDir, listChanges, readChange } from "../../change/server/index.ts";
import { hostClient, hostRunning, type SessionInfo } from "./host.ts";
import { ensureScreen } from "./session.ts";
import { clearStatus, pruneStatuses, statusOf, type AgentStatus } from "./status.ts";
import { pruneSnapshots, snapshotKey } from "./snapshots.ts";
import { presentWindow, type PresentedWindow } from "./presenter.ts";
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

const asFailure = (error: unknown): CommandFailure => ({
  message: error instanceof Error ? error.message : String(error),
  stderr: "",
  exitCode: 1,
});

/** The shell a new window runs: the user's own, or `/bin/sh` when the server has none. */
const shell = (): string => process.env.SHELL ?? "/bin/sh";

const freshId = (): string => `w-${randomBytes(5).toString("hex")}`;

/** Session ids the user explicitly closed. `pty.kill()` signals SIGHUP, which a process can
 * ignore, so the pty (and the host session) can outlive the close; without this tombstone a later
 * rebuild would re-adopt it and recreate the window. Ids are random, so a tombstone never blocks a
 * new session, and `hostLive` drops each one once its pty is gone. */
const closedSessions = new Set<string>();

/** Tombstone a pane's session id as explicitly closed. */
const markClosed = (sessionId: string): void => {
  closedSessions.add(sessionId);
};

/** The URL path the page opens the terminal socket on. The route and the client share this one
 * spelling, so it lives beside the route that serves it. */
export const terminalSocketPath = (id: string): string => `/api/changes/${encodeURIComponent(id)}/terminal/socket`;

/** The checkout's own CLI entry, put in front of a host session's PATH. An installed `corvi` from
 * another checkout may not have this channel's commands, and the server's `putCliOnPath`
 * deliberately lets an installed one win for `start`/`stop` — so a host session seeds the
 * matching entry explicitly. */
const cliBinDir = (): string => join(fileURLToPath(new URL("../../../../../", import.meta.url)), "apps", "cli", "bin");

/** The change's context for a host window. The host replaces its own environment with this one
 * (`session.open` env is the whole environment), so the scrub here actually wins. `TMUX` and
 * `TMUX_PANE` are dropped: a host session is not a tmux pane, and a reporter that inherited them
 * would write to a tmux server Corvi does not own. */
const changeEnv = (changeId: string, dir: string): Record<string, string> => {
  const child = childEnv(process.env, {
    [env("CHANGE_ID")]: changeId,
    [env("CHANGE_DIR")]: dir,
    // The app's log file, so an extension's own errors are filed instead of drawn into the pane:
    // the pty parses and persists whatever a Corvi command writes to stderr. Same file the
    // desktop pipes the server's output into.
    [env("LOG")]: join(stateDir(), "log"),
  });
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

/** The host sessions for a change, grouped into windows. A live session is a pane; a dead one is
 * only included when its window asked to keep it (`keep`) *and* the persisted record still lists
 * it (`known`), so a pane the user closed does not reappear as a frozen one. A host that is not
 * running has no sessions; it is not started just to be asked. */
const hostLive = async (
  changeId: string,
  keep: ReadonlySet<string>,
  known: ReadonlySet<string>,
): Promise<{ live: LiveWindow[]; sessions: Map<string, SessionInfo> }> => {
  if (!hostRunning()) return { live: [], sessions: new Map() };
  const client = await hostClient();
  const sessions = await client.list();
  // Drop tombstones whose pty is gone: once the host no longer reports the session alive it cannot
  // be re-adopted, so the set stays bounded by the lingering-kill window.
  const aliveIds = new Set(sessions.filter((session) => session.alive).map((session) => session.id));
  for (const id of closedSessions) if (!aliveIds.has(id)) closedSessions.delete(id);
  const grouped = new Map<string, string[]>();
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    if (session.metadata?.change !== changeId) continue;
    const window = session.metadata?.window ?? session.id;
    if (!session.alive) clearStatus(session.id, session.incarnation);
    // An explicitly closed pane is never re-adopted, even while its pty lingers.
    if (closedSessions.has(session.id)) continue;
    if (!session.alive && !(keep.has(window) && known.has(session.id))) continue;
    const panes = grouped.get(window) ?? [];
    panes.push(session.id);
    grouped.set(window, panes);
    byId.set(session.id, session);
  }
  const live: LiveWindow[] = [...grouped].map(([id, panes]) => ({ id, kind: "host" as const, panes }));
  return { live, sessions: byId };
};

/** The live host windows of a change, plus the session map the presenter reads status from. The
 * keep-open and known-pane sets come from the persisted records, so a rebuild cannot resurrect a
 * pane that was explicitly closed. */
const liveFor = async (changeId: string): Promise<{ live: LiveWindow[]; host: Map<string, SessionInfo> }> => {
  const previous = registryRecords(changeId);
  const keep = new Set(previous.filter((record) => record.keepOpen).map((record) => record.id));
  const known = new Set(previous.flatMap((record) => [...record.panes]));
  const host = await hostLive(changeId, keep, known);
  return { live: host.live, host: host.sessions };
};

/** The option facts a host window adds for the agent presenter: the status its reporter set,
 * through the CLI/HTTP store or the OSC parse, in the same vocabulary the presenters read. */
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
const hostRaw = (record: WindowRecord, dir: string, session: SessionInfo | undefined, status: AgentStatus | undefined): RawWindow => ({
  index: 0,
  id: record.id,
  name: record.label ?? basename(dir),
  command: record.label !== undefined ? "sh" : (record.command ?? "sh"),
  active: record.active,
  activity: record.activity,
  directory: basename(dir),
  named: true,
  options: { ...agentOptions(status), ...commandOptions(record, session) },
  panes: [...record.panes],
  activePane: record.activePane,
});

/** The change's windows, presented. Rebuilds and persists the registry from the live host
 * sessions. */
export const listWindowsAsync = (changeId: string): Promise<PresentedWindow[]> =>
  withRegistryLock(async () => {
    const dir = await dirOf(changeId);
    const { live, host } = await liveFor(changeId);
    const records = rebuild(changeId, live);
    return records.map((record, index) => {
      // A window's label and status come from its active pane; a split window is still one tab.
      const session = host.get(record.activePane) ?? host.get(record.panes[0] ?? "");
      const stored = session === undefined ? undefined : statusOf(session.id, session.incarnation);
      // `undefined` means nothing was reported (use the host's OSC parse); `null` is an explicit
      // clear and suppresses the fallback.
      const status = stored === undefined ? session?.status : (stored ?? undefined);
      return presentWindow({ ...hostRaw(record, dir, session, status), index });
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
  // A snapshot survives only while its session is live or its record asked to be kept open (a
  // frozen command window is still worth looking behind). Everything else — a dead incarnation,
  // a session that exited while detached — is pruned here, on the watcher's poll.
  const keptOpen = keptOpenPanes([...existing].map((changeId) => registryRecords(changeId)));
  pruneSnapshots(liveSnapshotKeys(sessions, keptOpen));
  const ids = new Set<string>(existing);
  for (const session of sessions) {
    if (session.alive && session.metadata?.change && existing.has(session.metadata.change)) ids.add(session.metadata.change);
  }
  const result: Record<string, PresentedWindow[]> = {};
  for (const id of ids) result[id] = await listWindowsAsync(id);
  return result;
};

type RecordExtra = Pick<WindowRecord, "command" | "label" | "keepOpen" | "notify">;

/** The pane session ids whose window asked to be kept open, across every change's records. A pane
 * is named directly, not by its window, so closing a pane releases its own retained screen even
 * when the window (and its other panes) live on. Pure, so the rule is testable without a registry
 * file. */
export const keptOpenPanes = (recordsByChange: readonly (readonly WindowRecord[])[]): Set<string> => {
  const ids = new Set<string>();
  for (const records of recordsByChange) {
    for (const record of records) {
      if (!record.keepOpen) continue;
      for (const pane of record.panes) ids.add(pane);
    }
  }
  return ids;
};

/** Whether a pane's window asked to be kept open. The session hub holds a pane's screen after its
 * session exits only while the record still lists that pane, so a pane the user closed is released
 * — even the window's first, whose session id equals the window id. */
export const isKeptOpen = (changeId: string, paneSessionId: string): boolean =>
  registryRecords(changeId).some((record) => record.keepOpen === true && record.panes.includes(paneSessionId));

/** The `(id, incarnation)` snapshot keys to keep: live sessions, plus the panes of a kept-open
 * window (their frozen output must still be replayable). A closed pane is no longer in its record,
 * so its snapshot is pruned; dead sessions that were not kept are pruned too. */
export const liveSnapshotKeys = (
  sessions: readonly SessionInfo[],
  keptOpen: ReadonlySet<string>,
): Set<string> =>
  new Set(
    sessions
      .filter((session) => session.alive || keptOpen.has(session.id))
      .map((session) => snapshotKey(session.id, session.incarnation)),
  );

/** Rebuild, apply a patch, mark `id` active, and persist. Caller holds the registry lock. */
const activate = async (changeId: string, id: string, patch: Partial<WindowRecord> = {}): Promise<WindowRecord[]> => {
  const { live } = await liveFor(changeId);
  const base = rebuild(changeId, live);
  const present = base.some((record) => record.id === id)
    ? base
    : [
        ...base,
        {
          id,
          kind: "host" as const,
          panes: [id],
          activePane: id,
          active: false,
          activity: false,
          createdAt: new Date().toISOString(),
          ...patch,
        },
      ];
  return save(
    changeId,
    present.map((record) => (record.id === id ? { ...record, ...patch, active: true, activity: false } : { ...record, active: false })),
  );
};

/** The host-session options a window beyond the defaults needs: a different working directory
 * (a subagent runs in its own directory), a change env seeded from the change's directory (not
 * the process cwd), extra environment, and extra metadata the host carries for discovery. */
type HostWindowOptions = {
  readonly cwd?: string;
  readonly envDir?: string;
  readonly env?: Record<string, string>;
  readonly metadata?: Record<string, string>;
};

/** Open a host window running `command` (or a shell) and make it the active one. Caller holds the
 * registry lock. */
const openHostWindow = async (
  changeId: string,
  dir: string,
  command: readonly string[],
  size: { readonly cols: number; readonly rows: number },
  extra: RecordExtra = {},
  options: HostWindowOptions = {},
): Promise<string> => {
  const id = freshId();
  // The first pane's session id is the window id, so a legacy single-pane record (whose id was
  // its session id) is just a window with that one pane; a split pane gets its own id.
  await openPane(changeId, id, id, dir, command, size, options);
  await activate(changeId, id, extra);
  return id;
};

/** Open one pane (a host session) of a window and create and attach its screen. The metadata
 * names both the window and the pane, so the registry rebuild re-associates it and a split's
 * pane is not mistaken for a window of its own. */
const openPane = async (
  changeId: string,
  windowId: string,
  paneId: string,
  dir: string,
  command: readonly string[],
  size: { readonly cols: number; readonly rows: number },
  options: HostWindowOptions = {},
): Promise<void> => {
  const client = await hostClient();
  const { incarnation } = await client.open(paneId, {
    cwd: options.cwd ?? dir,
    command: [...command],
    cols: size.cols,
    rows: size.rows,
    env: { ...changeEnv(changeId, options.envDir ?? dir), ...options.env },
    metadata: { change: changeId, window: windowId, pane: paneId, ...options.metadata },
  });
  // The screen exists for the pane's whole life, not only while a page is attached: a pane opened
  // with no page (a subagent, a command) captures its startup before the host's ring can evict it.
  await ensureScreen(changeId, paneId, incarnation, size).catch(() => undefined);
};

const listRecords = async (changeId: string): Promise<WindowRecord[]> => {
  const { live } = await liveFor(changeId);
  return rebuild(changeId, live);
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
  options: NewWindowOptions,
): Promise<string> =>
  withRegistryLock(() =>
    openHostWindow(changeId, options.cwd ?? dir, [shell(), "-c", command], { cols: 100, rows: 30 }, {
      command,
      ...(options.announce?.label ? { label: options.announce.label } : {}),
      ...(options.keepOpen || options.announce?.notify ? { keepOpen: true } : {}),
      ...(options.announce ? { notify: options.announce.notify } : {}),
    }),
  );

/** Open a subagent's host window: the working directory is the subagent's own (which, with the
 * harness's `--session-id`, is what resumes the same harness session on a reopen), the change env
 * carries `CORVI_SUBAGENT_ID` so the relay can identify itself, and the metadata carries
 * `subagentId` so the host list discovers it. */
export const newSubagentWindowAsync = (
  changeId: string,
  args: {
    readonly changeDir: string;
    readonly cwd: string;
    readonly subagentId: string;
    readonly label: string;
    readonly command: readonly string[];
  },
): Promise<string> =>
  withRegistryLock(() =>
    openHostWindow(
      changeId,
      args.changeDir,
      args.command,
      { cols: 100, rows: 30 },
      { command: args.command.join(" "), label: args.label },
      {
        cwd: args.cwd,
        envDir: args.changeDir,
        env: { CORVI_SUBAGENT_ID: args.subagentId },
        metadata: { subagentId: args.subagentId },
      },
    ),
  );

export const newSubagentWindow = (
  changeId: string,
  args: Parameters<typeof newSubagentWindowAsync>[1],
): Effect.Effect<string, CommandFailure> => Effect.tryPromise({ try: () => newSubagentWindowAsync(changeId, args), catch: asFailure });

/** Kill a subagent's host session and drop its pane, or the window if it was the last pane. */
export const killHostWindowAsync = async (changeId: string, sessionId: string): Promise<void> =>
  withRegistryLock(async () => {
    const records = await listRecords(changeId);
    const record = records.find((r) => r.panes.includes(sessionId));
    if (record === undefined) {
      markClosed(sessionId);
      if (hostRunning()) await (await hostClient()).kill(sessionId).catch(() => undefined);
      return;
    }
    await closePaneUnlocked(changeId, record.id, sessionId);
  });

export const killHostWindow = (changeId: string, sessionId: string): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({ try: () => killHostWindowAsync(changeId, sessionId), catch: asFailure });

/** A live subagent host session, as the subagent store sees it: the record's `window` id, its
 * registry index (what the page focuses), and its reported status. */
export type LiveSubagent = {
  readonly window: string;
  readonly index: number;
  readonly agentStatus?: "working" | "waiting";
};

/** The live subagent host sessions of a change, keyed by subagent id. A host that is not running
 * has none; presence is best-effort, never a request failure. Status comes from the CLI/HTTP
 * store first, then the host's own OSC parse. */
export const liveSubagentsAsync = async (changeId: string): Promise<Map<string, LiveSubagent>> => {
  const map = new Map<string, LiveSubagent>();
  if (!hostRunning()) return map;
  const sessions = await (await hostClient()).list();
  // The index is the page's own: it comes from the same locked rebuild `listWindowsAsync` gives the
  // window strip, not from the raw persisted records (which a concurrent open could leave stale).
  const windows = await listWindowsAsync(changeId);
  const indexOf = new Map(windows.map((window, index) => [window.id, index]));
  for (const session of sessions) {
    if (!session.alive || session.metadata?.change !== changeId) continue;
    const subagentId = session.metadata?.subagentId?.trim();
    if (!subagentId) continue;
    const stored = statusOf(session.id, session.incarnation);
    const state = stored === undefined ? session.status?.state : (stored ?? undefined)?.state;
    const windowId = session.metadata?.window ?? session.id;
    map.set(subagentId, {
      window: session.id,
      index: indexOf.get(windowId) ?? 0,
      ...(state === "working" || state === "waiting" ? { agentStatus: state } : {}),
    });
  }
  return map;
};

export const liveSubagents = (changeId: string): Effect.Effect<Map<string, LiveSubagent>, CommandFailure> =>
  Effect.tryPromise({ try: () => liveSubagentsAsync(changeId), catch: asFailure });

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

/** Split the window: a new pane in the active pane's directory, focused. `direction` is the
 * page's to compose (5b); the server records the pane and focuses it. Caller holds the lock. */
export const splitPaneAsync = (changeId: string, windowId: string, direction: "right" | "down"): Promise<void> =>
  withRegistryLock(async () => {
    void direction;
    const records = await listRecords(changeId);
    const record = records.find((entry) => entry.id === windowId);
    if (record === undefined || record.activePane === "") return;
    const sessions = hostRunning() ? await (await hostClient()).list() : [];
    const active = sessions.find((session) => session.id === record.activePane);
    const cwd = active?.cwd ?? (await dirOf(changeId));
    const paneId = freshId();
    // The pane's metadata names the window, so a rebuild adopts it the moment its session exists:
    // a crash between opening it and the focus save cannot orphan it.
    await openPane(changeId, windowId, paneId, cwd, [shell()], { cols: 100, rows: 30 });
    try {
      const after = await listRecords(changeId);
      save(
        changeId,
        after.map((entry) => {
          if (entry.id !== windowId) return { ...entry, active: false };
          const panes = entry.panes.includes(paneId) ? entry.panes : [...entry.panes, paneId];
          return { ...entry, panes, activePane: paneId, active: true, activity: false };
        }),
      );
    } catch (error) {
      // The session is live but could not be recorded; close it rather than leave a pane nothing
      // will show. A crash cannot be caught, but the adopt rule recovers the pane on the next read.
      markClosed(paneId);
      if (hostRunning()) await (await hostClient()).kill(paneId).catch(() => undefined);
      throw error;
    }
  });

/** Kill a pane and drop it from its window; the window goes too when it was the last pane. The
 * caller holds the registry lock (this is the shared half of close-pane and subagent close). */
const closePaneUnlocked = async (changeId: string, windowId: string, paneSessionId: string): Promise<void> => {
  // Tombstone before signalling: the pty can outlive `kill` (a process that ignores SIGHUP), and a
  // rebuild must not re-adopt it in the meantime.
  markClosed(paneSessionId);
  if (hostRunning()) await (await hostClient()).kill(paneSessionId).catch(() => undefined);
  const records = await listRecords(changeId);
  const record = records.find((entry) => entry.id === windowId);
  if (record === undefined) return;
  const panes = record.panes.filter((pane) => pane !== paneSessionId);
  if (panes.length === 0) {
    save(changeId, records.filter((entry) => entry.id !== windowId));
    return;
  }
  const activePane = record.activePane === paneSessionId ? panes[0]! : record.activePane;
  save(changeId, records.map((entry) => (entry.id === windowId ? { ...entry, panes, activePane } : entry)));
};

/** Close one pane; the window survives if it has another. */
export const closePaneAsync = (changeId: string, windowId: string, paneSessionId: string): Promise<void> =>
  withRegistryLock(() => closePaneUnlocked(changeId, windowId, paneSessionId));

/** Focus one pane of a window, and bring its window to the front. */
export const focusPaneAsync = (changeId: string, windowId: string, paneSessionId: string): Promise<void> =>
  withRegistryLock(async () => {
    const records = await listRecords(changeId);
    const record = records.find((entry) => entry.id === windowId);
    if (record === undefined || !record.panes.includes(paneSessionId)) return;
    save(
      changeId,
      records.map((entry) =>
        entry.id === windowId
          ? { ...entry, active: true, activity: false, activePane: paneSessionId }
          : { ...entry, active: false },
      ),
    );
  });

/** The host session the change's socket attaches to: the requested pane, the active window's
 * active pane, or a new window. A stale pane id falls through; callers that name no pane get the
 * active one. */
export const ensureActiveHostWindow = (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number },
  sessionId?: string,
): Promise<string> =>
  withRegistryLock(async () => {
    const records = await listRecords(changeId);
    if (sessionId !== undefined && records.some((record) => record.panes.includes(sessionId))) return sessionId;
    const active =
      records.find((record) => record.active && record.kind === "host") ??
      records.find((record) => record.kind === "host");
    if (active !== undefined && active.activePane !== "") return active.activePane;
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
        if (session.metadata?.change !== changeId) continue;
        markClosed(session.id);
        await client.kill(session.id).catch(() => undefined);
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

export const splitPane = (
  changeId: string,
  windowId: string,
  direction: "right" | "down",
): Effect.Effect<void, CommandFailure> => Effect.tryPromise({ try: () => splitPaneAsync(changeId, windowId, direction), catch: asFailure });

export const closePane = (changeId: string, windowId: string, paneSessionId: string): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({ try: () => closePaneAsync(changeId, windowId, paneSessionId), catch: asFailure });

export const focusPane = (changeId: string, windowId: string, paneSessionId: string): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({ try: () => focusPaneAsync(changeId, windowId, paneSessionId), catch: asFailure });
