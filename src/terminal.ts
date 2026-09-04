import { basename } from "node:path";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import type { Change } from "./types.ts";
import { join } from "node:path";
import { changeDir } from "./changes.ts";
import { sh, shOrThrow } from "./sh.ts";
import type { AgentState } from "./terminalTypes.ts";

/**
 * A terminal for a change: one tmux session, started in the change directory, served to the
 * browser by ttyd.
 *
 * tmux owns the session, not us. Windows and panes are yours to make with the usual keys, the
 * shells survive an IWE restart, and `tmux attach -t iwe-<id>` from any terminal reaches the
 * same session as the browser does.
 */
export const sessionName = (id: string): string => `iwe-${id}`;

/** Where ttyd's own logging goes; the process is detached, so this is all there is to read. */
export const logPath = (id: string): string => `/tmp/iwe-ttyd-${id}.log`;

type Running = { port: number; pid: number };

/** Promises, not results: two requests arriving together (a re-render, two open tabs) must start
 * one ttyd between them. Storing the result instead let the second start kill the first. */
const running = new Map<string, Promise<Running>>();

/** Where the running ttyd is written down, so the next run of the server finds it again. In the
 * change directory rather than in memory: a restart, a hot reload or a crash all forget the map,
 * and killing a working terminal because we lost our notes is no way to behave. */
const notePath = (id: string): string => join(changeDir(id), "terminal.json");

async function noteOf(id: string): Promise<Running | undefined> {
  const note = await Bun.file(notePath(id))
    .json()
    .catch(() => undefined);
  return note && typeof note.pid === "number" && typeof note.port === "number" ? note : undefined;
}

/** The ttyd of a previous run, if it is still there and still serving this change. */
async function adopt(id: string): Promise<Running | undefined> {
  const note = await noteOf(id);
  if (!note || !alive(note.pid)) return undefined;
  // Alive is not enough: the pid could have been reused by anything. Only a ttyd answering on
  // the port we wrote down is the terminal we left behind.
  return (await accepts(note.port)) ? note : undefined;
}

/** A free port, asked of the operating system rather than guessed. */
async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0 asks whether it exists, without touching it
    return true;
  } catch {
    return false;
  }
};

/** Where the browser loads the terminal from: our own origin, which proxies ttyd. Same-origin
 * so the page can reach into the frame — to focus it, and to fix up keys the browser cannot
 * encode by itself. */
export const terminalPath = (id: string): string => `/terminal/${encodeURIComponent(id)}/`;

/** The port ttyd serves this change on, starting or adopting it as needed. */
export async function terminalPort(change: Change): Promise<number> {
  // Starting one would write into a directory that has moved to the archive, recreating it.
  if (change.completedAt) throw new Error("this change is completed: its terminal is gone");
  const existing = running.get(change.id);
  if (!existing) {
    // Nothing in memory: the server was restarted, or reloaded itself. The terminal probably
    // outlived it, and reconnecting to it keeps whatever you were running.
    const adopted = await adopt(change.id);
    if (adopted) {
      running.set(change.id, Promise.resolve(adopted));
      return adopted.port;
    }
  }
  if (existing) {
    // A start that failed or hung must not be cached: awaiting it again would hand every later
    // request the same broken answer, or the same wait forever.
    const found = await existing.catch(() => undefined);
    if (found && alive(found.pid)) return found.port;
    running.delete(change.id);
  }
  // Set before the first await, so a second caller finds this start instead of beginning another.
  // Bounded, because a request that hangs forever is the one failure the browser cannot report:
  // it just spins. Whatever goes wrong, the next attempt starts from scratch.
  const started = withTimeout(start(change), 20_000).catch((e: unknown) => {
    running.delete(change.id);
    throw e;
  });
  running.set(change.id, started);
  return (await started).port;
}

const withTimeout = <T,>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    work,
    Bun.sleep(ms).then<never>(() => {
      throw new Error(`starting the terminal took longer than ${ms / 1000}s`);
    }),
  ]);

async function start(change: Change): Promise<Running> {
  // Only reached when no ttyd could be adopted, so anything still running for this change is a
  // leftover that nothing can reach: a port we no longer know, or a process that stopped
  // answering. The tmux session behind it survives either way.
  await sh(["pkill", "-f", `new-session -A -s ${sessionName(change.id)}`]);

  const port = await freePort();
  const logFd = openSync(logPath(change.id), "a");
  const child = spawn(
    "ttyd",
    [
      "--writable",
      "--interface",
      "lo0", // localhost only: this is a shell, it has no business on the network
      "--port",
      String(port),
      "-t",
      "fontSize=13",
      "-t",
      'theme={"background":"#0d1117","foreground":"#e6edf3"}',
      // With tmux's mouse mode on, the mouse belongs to tmux and dragging never reaches the
      // browser. xterm.js can be told to hand it back while a modifier is held — on macOS that
      // modifier is option, and only if this is switched on. Without it there is no way to
      // select text for the system clipboard at all.
      "-t",
      "macOptionClickForcesSelection=true",
      "tmux",
      "new-session",
      "-A", // attach if it exists, create if it does not
      "-s",
      sessionName(change.id),
      "-c",
      changeDir(change.id),
      // A scroll wheel should scroll, not walk back through your shell history. Scoped to this
      // session with -t, so tmux sessions you started yourself keep your own settings.
      ";",
      "set-option",
      "-t",
      sessionName(change.id),
      "mouse",
      "on",
      // Windows that produced output since you last looked at them are flagged, which is what
      // the strip above the terminal draws a dot for.
      ";",
      "set-option",
      "-t",
      sessionName(change.id),
      "monitor-activity",
      "on",
      // The flag is the point; the message across the status bar is not.
      ";",
      "set-option",
      "-t",
      sessionName(change.id),
      "visual-activity",
      "off",
      // Modified Enter and friends only reach an application when tmux is willing to forward
      // them, in the encoding the browser sends (CSI u). A server option: tmux keeps one set of
      // these for every session it runs, ours included.
      ";",
      "set-option",
      "-s",
      "extended-keys",
      "on",
      ";",
      "set-option",
      "-s",
      "extended-keys-format",
      "csi-u",
    ],
    // Detached so a server reload does not take your shells with it. Its output goes to a log
    // rather than /dev/null: when a terminal comes up blank, ttyd's own words are the fastest
    // way to find out why.
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  closeSync(logFd); // ttyd holds its own copy now
  await listening(port);
  const found = { port, pid: child.pid! };
  await Bun.write(notePath(change.id), JSON.stringify(found) + "\n");
  return found;
}

/** Whether something accepts connections on this port. A plain TCP connect, not an HTTP request:
 * this only has to answer "is it open", and an HTTP client brings a connection pool and timeouts
 * of its own to a question that simple. */
const accepts = (port: number): Promise<boolean> =>
  Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open: (s) => {
        s.end();
      },
      data() {},
      error() {},
    },
  }).then(
    () => true,
    () => false,
  );

/** ttyd needs a moment to bind. Returning before it does hands the browser a URL that refuses
 * the connection, and an iframe does not retry: it just sits there empty. */
async function listening(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await accepts(port)) return;
    await Bun.sleep(50);
  }
  throw new Error(`ttyd did not open port ${port} within 5s; see /tmp/iwe-ttyd-*.log`);
}

/** Drop the terminal of a change: the ttyd server and the tmux session with its shells. Called
 * when a change is completed, since its directory moves into the archive underneath it. */
export async function stopTerminal(id: string): Promise<void> {
  const found = (await running.get(id)?.catch(() => undefined)) ?? (await noteOf(id));
  if (found && alive(found.pid)) process.kill(found.pid);
  running.delete(id);
  await sh(["tmux", "kill-session", "-t", sessionName(id)]);
}

/* Terminals are deliberately left running when the server stops: restarting IWE while you work on
 * it is constant, and losing the shells every time is not worth the tidiness. They are noted in
 * the change directory and adopted again on the next start; completing a change ends one for
 * good, and so does closing its last window. */

/** One tmux window of a change, as the strip above the terminal shows it. */
export type TerminalWindow = {
  index: number;
  name: string;
  /** What is actually running in the active pane: zsh, nvim, gradle, ... */
  command: string;
  active: boolean;
  /** Output arrived since you last looked at it. */
  activity: boolean;
  /** Directory of the active pane: which repository the window is in, which is usually what you
   * want to know about it. */
  directory: string;
  /** Whether the name is one you gave it. tmux renames a window after whatever runs in it until
   * you name it yourself, which switches automatic renaming off. */
  named: boolean;
  /** What a coding agent in this window is doing, when it says so in the pane title. */
  agent?: AgentState;
};

export type { AgentState };

/**
 * An agent's own account of itself, read from the `@agent` tmux pane option.
 *
 * A window running pi looks like any other `node` process, so nothing here can tell "thinking"
 * from "waiting for you to answer" — which is the one thing worth knowing about it. pi's
 * `busy-title` extension sets `@agent` on its pane (`tmux set -p @agent working`).
 *
 * A pane option rather than the pane title: the title is shared with pi's own session name and
 * with the shell, which rewrite it constantly, and the marker kept being overwritten seconds
 * after it was set. Nobody else writes `@agent`, and tmux drops it when the pane dies, so a
 * crashed agent leaves nothing stale behind.
 */
export const agentIn = (option: string): AgentState | undefined =>
  option === "working" || option === "waiting" ? option : undefined;

const FORMAT =
  "#{window_index}\t#{window_name}\t#{pane_current_command}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{automatic-rename}\t#{@agent}";

const parseWindow = (line: string): TerminalWindow => {
  const [index, name, command, active, activity, path, auto, agent] = line.split("\t");
  return {
    index: Number(index),
    name: name ?? "",
    command: command ?? "",
    active: active === "1",
    activity: activity === "1",
    directory: basename(path ?? ""),
    named: auto === "0",
    agent: agentIn(agent ?? ""),
  };
};

export async function listWindows(id: string): Promise<TerminalWindow[]> {
  const r = await sh(["tmux", "list-windows", "-t", sessionName(id), "-F", FORMAT]);
  if (r.code !== 0) return []; // no session yet: the terminal was never opened
  return r.stdout.split("\n").filter(Boolean).map(parseWindow);
}

/** Which change a tmux session belongs to, or undefined for a session that is not ours. */
export const changeOfSession = (session: string): string | undefined =>
  session.startsWith("iwe-") ? session.slice("iwe-".length) : undefined;

/**
 * Every change's windows, in one call.
 *
 * The navigation column lists the terminals of every change at once, and asking tmux per change
 * would be a process per change every few seconds. `list-windows -a` answers for every session
 * there is; the ones that are not ours are dropped by their name.
 */
export async function allWindows(): Promise<Record<string, TerminalWindow[]>> {
  const r = await sh(["tmux", "list-windows", "-a", "-F", `#{session_name}\t${FORMAT}`]);
  if (r.code !== 0) return {}; // no server running: nobody has opened a terminal yet
  const byChange: Record<string, TerminalWindow[]> = {};
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const id = changeOfSession(line.slice(0, tab));
    if (!id) continue;
    (byChange[id] ??= []).push(parseWindow(line.slice(tab + 1)));
  }
  return byChange;
}

/**
 * A new window beside the current one, starting where the current one is: a new tab is nearly
 * always "the same place, another thing", and `#{pane_current_path}` is what tmux's own `c`
 * binding uses. Falls back to the change directory when there is no current pane to ask.
 */
export async function newWindow(id: string): Promise<void> {
  const here = await sh([
    "tmux",
    "new-window",
    "-t",
    sessionName(id),
    "-c",
    "#{pane_current_path}",
  ]);
  if (here.code === 0) return;
  await shOrThrow(["tmux", "new-window", "-t", sessionName(id), "-c", changeDir(id)]);
}

export async function selectWindow(id: string, index: number): Promise<void> {
  await shOrThrow(["tmux", "select-window", "-t", `${sessionName(id)}:${index}`]);
}
