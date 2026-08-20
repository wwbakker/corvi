import { basename } from "node:path";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import type { Change } from "./types.ts";
import { changeDir } from "./changes.ts";
import { sh, shOrThrow } from "./sh.ts";

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

/** ttyd for this change, started if it is not already running. Returns the URL to embed. */
export async function terminalUrl(change: Change): Promise<string> {
  const existing = running.get(change.id);
  if (existing) {
    // A start that failed or hung must not be cached: awaiting it again would hand every later
    // request the same broken answer, or the same wait forever.
    const found = await existing.catch(() => undefined);
    if (found && alive(found.pid)) return `http://127.0.0.1:${found.port}`;
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
  return `http://127.0.0.1:${(await started).port}`;
}

const withTimeout = <T,>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    work,
    Bun.sleep(ms).then<never>(() => {
      throw new Error(`starting the terminal took longer than ${ms / 1000}s`);
    }),
  ]);

async function start(change: Change): Promise<Running> {
  // A ttyd from a previous run of the server (a hot reload forgets the map, the process keeps
  // going) would otherwise pile up, one per reload. The tmux session behind it survives this.
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
    ],
    // Detached so a server reload does not take your shells with it. Its output goes to a log
    // rather than /dev/null: when a terminal comes up blank, ttyd's own words are the fastest
    // way to find out why.
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  closeSync(logFd); // ttyd holds its own copy now
  await listening(port);
  return { port, pid: child.pid! };
}

/** ttyd needs a moment to bind. Returning before it does hands the browser a URL that refuses
 * the connection, and an iframe does not retry: it just sits there empty.
 *
 * A plain TCP connect, not an HTTP request: this only has to answer "is the port open yet", and
 * an HTTP client brings a connection pool and timeouts of its own to a question that simple. */
async function listening(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const open = await Bun.connect({
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
    if (open) return;
    await Bun.sleep(50);
  }
  throw new Error(`ttyd did not open port ${port} within 5s; see /tmp/iwe-ttyd-*.log`);
}

/** Drop the terminal of a change: the ttyd server and the tmux session with its shells. Called
 * when a change is completed, since its directory moves into the archive underneath it. */
export async function stopTerminal(id: string): Promise<void> {
  const found = await running.get(id);
  if (found && alive(found.pid)) process.kill(found.pid);
  running.delete(id);
  await sh(["tmux", "kill-session", "-t", sessionName(id)]);
}

/** ttyd survives us otherwise: it is detached so a reload of the server does not kill your
 * shells, which means the exit path has to be explicit. */
export async function stopAllTerminals(): Promise<void> {
  for (const pending of running.values()) {
    const { pid } = await pending;
    if (alive(pid)) process.kill(pid);
  }
  running.clear();
}

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
};

const FORMAT =
  "#{window_index}\t#{window_name}\t#{pane_current_command}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{automatic-rename}";

export async function listWindows(id: string): Promise<TerminalWindow[]> {
  const r = await sh(["tmux", "list-windows", "-t", sessionName(id), "-F", FORMAT]);
  if (r.code !== 0) return []; // no session yet: the terminal tab was never opened
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, command, active, activity, path, auto] = line.split("\t");
      return {
        index: Number(index),
        name: name ?? "",
        command: command ?? "",
        active: active === "1",
        activity: activity === "1",
        directory: basename(path ?? ""),
        named: auto === "0",
      };
    });
}

export async function newWindow(id: string): Promise<void> {
  await shOrThrow(["tmux", "new-window", "-t", sessionName(id), "-c", changeDir(id)]);
}

export async function selectWindow(id: string, index: number): Promise<void> {
  await shOrThrow(["tmux", "select-window", "-t", `${sessionName(id)}:${index}`]);
}
