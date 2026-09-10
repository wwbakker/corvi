import { basename } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { Deferred, Duration, Effect, Exit } from "effect";
import type { Change } from "./types.ts";
import { join } from "node:path";
import { changeDir } from "./changes.ts";
import { isLinux, isMac, loopbackInterface, commandAvailable } from "./platform.ts";
import { sh, shOrThrow, type Result } from "./sh.ts";
import { BadRequestError, CliError } from "./effect/errors.ts";
import type { TerminalWindow } from "./terminalTypes.ts";
import type { TmuxWindow, WindowPresentation } from "./extensions/api.ts";
import { windowPresenters } from "./extensions/registry.ts";

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

type Running = { port: number; pid: number; /** When the ttyd was started: the session behind it
 * only exists once a browser has connected, and that takes a moment. */ at?: number };

/** errors.ts's Data.TaggedError leaves `message` empty; the taxonomy requires each error to
 * carry a human-readable message, so set it explicitly (as sh.ts's failCli does). */
const cliError = (tool: string, command: string, message: string, exitCode: number): CliError =>
  new CliError({ tool, command, stderr: message, exitCode, message });

/** The Result-branching contract: the one failure `sh` can raise here is a timeout, which
 * surfaces as a failed command (exit code 124) rather than a failure of the operation, so
 * everything downstream branches on `code`. */
const shResult = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  sh(cmd, cwd).pipe(
    Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
  );

/**
 * Deferreds, not results: two requests arriving together (a re-render, two open tabs) must start
 * one ttyd between them. The keyed Deferred is registered before the first yield of a start, so
 * the second request joins the first's start; storing the result instead let the second start
 * kill the first.
 */
const running = new Map<string, Deferred.Deferred<Running, CliError>>();

/** Where the running ttyd is written down, so the next run of the server finds it again. In the
 * change directory rather than in memory: a restart, a hot reload or a crash all forget the map,
 * and killing a working terminal because we lost our notes is no way to behave. */
const notePath = (id: string): string => join(changeDir(id), "terminal.json");

const noteOfEffect: (id: string) => Effect.Effect<Running | undefined> = (id) =>
  Effect.map(
    // A missing or malformed note is no note at all: what `.catch(() => undefined)` did.
    Effect.promise(() => Bun.file(notePath(id)).json().catch(() => undefined)),
    (note) =>
      note && typeof note.pid === "number" && typeof note.port === "number"
        ? (note as Running)
        : undefined,
  );

/** The ttyd of a previous run, if it is still there and still serving this change. */
const adoptEffect = (id: string): Effect.Effect<Running | undefined> =>
  Effect.gen(function* () {
    const note = yield* noteOfEffect(id);
    if (!note || !alive(note.pid)) return undefined;
    // Alive is not enough: the pid could have been reused by anything. Only a ttyd answering on
    // the port we wrote down is the terminal we left behind.
    return (yield* acceptsEffect(note.port)) ? note : undefined;
  });

/** A free port, asked of the operating system rather than guessed. */
function freePort(): number {
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
 * encode by itself.
 *
 * On Linux the frame carries ttyd's `rendererType=canvas` override. The default WebGL renderer
 * draws into a webgl2 canvas that WebKitGTK — this machine's NVIDIA setup included — presents
 * a frame late: a keystroke's output reaches the page in a millisecond (measured) but lands on
 * screen only when the next one renders, so the terminal reads one keystroke behind. The 2D
 * canvas renderer goes through a presentation path without the problem; macOS keeps WebGL. */
export const terminalPath = (id: string): string =>
  `/terminal/${encodeURIComponent(id)}/${isLinux ? "?rendererType=canvas" : ""}`;

/** The port ttyd serves this change on, starting or adopting it as needed.
 *
 * The Effect fails with the typed taxonomy: a completed change is a `BadRequestError` (the
 * state forbids it), a missing tool or a start that never came up is a `CliError`. Both carry a
 * human-readable message. */
export const terminalPort = (change: Change): Effect.Effect<number, BadRequestError | CliError> =>
  Effect.gen(function* () {
    // Starting one would write into a directory that has moved to the archive, recreating it.
    if (change.completedAt) {
      const message = "this change is completed: its terminal is gone";
      // 400, not 409: the state is not forceable, and nothing about the request is retryable
      // against a completed change.
      return yield* Effect.fail(new BadRequestError({ message }));
    }
    const joinOrStart = (): Effect.Effect<number, CliError> =>
      Effect.gen(function* () {
        const existing = running.get(change.id);
        if (existing) {
          // A start that failed or hung must not be cached: awaiting it again would hand every
          // later request the same broken answer, or the same wait forever.
          const outcome = yield* Effect.exit(Deferred.await(existing));
          if (Exit.isSuccess(outcome) && alive(outcome.value.pid)) return outcome.value.port;
          running.delete(change.id);
          return yield* joinOrStart(); // start fresh
        }
        // Register before the first yield, so a request arriving together with this one finds
        // this start instead of beginning another.
        const deferred = yield* Deferred.make<Running, CliError>();
        const claimed = running.get(change.id) ?? (running.set(change.id, deferred), deferred);
        if (claimed !== deferred) return yield* joinOrStart(); // someone else just claimed it
        // Nothing in memory: the server was restarted, or reloaded itself. The terminal probably
        // outlived it, and reconnecting to it keeps whatever you were running.
        const adopted = yield* adoptEffect(change.id);
        if (adopted) {
          yield* Deferred.succeed(deferred, adopted);
          return adopted.port;
        }
        // The start runs on a daemon of its own, so the outcome — good or bad — is shared with
        // everyone who joined this start via the Deferred, and a start that is merely slow keeps
        // going and writes its note, so the next attempt adopts it. A start that failed is not
        // cached.
        yield* Effect.forkDaemon(
          Effect.gen(function* () {
            const outcome = yield* Effect.exit(startEffect(change));
            if (Exit.isFailure(outcome)) running.delete(change.id);
            yield* Deferred.done(deferred, outcome);
          }),
        );
        // Bounded, because a request that hangs forever is the one failure the browser cannot
        // report: it just spins. The timeout abandons the wait, not the detached ttyd, which is
        // what makes restart survival possible at all — so nothing is killed here.
        const waited = yield* Effect.exit(
          Effect.timeout(Deferred.await(deferred), Duration.seconds(20)),
        );
        if (Exit.isSuccess(waited)) return waited.value.port;
        return yield* Effect.fail(
          cliError("ttyd", "ttyd", "starting the terminal took longer than 20s", 124),
        );
      });
    return yield* joinOrStart();
  });


/** Whether the ttyd on record has outlived its tmux session: the shells are gone, and the page
 * would show a dead terminal. Reported rather than acted on — starting a fresh session would
 * throw away the message that something was lost. A note that has only just been written is not
 * judged: its session is created when the browser connects, a moment after the ttyd starts. */
export const terminalGone = (id: string): Effect.Effect<{ gone: boolean; pid?: number }> =>
  Effect.gen(function* () {
    const note = yield* noteOfEffect(id);
    if (!note || !alive(note.pid)) return { gone: false };
    if (note.at !== undefined && Date.now() - note.at < 5000) return { gone: false };
    const r = yield* shResult(["tmux", "has-session", "-t", sessionName(id)]);
    return r.code === 0 ? { gone: false } : { gone: true, pid: note.pid };
  }).pipe(
    // A tmux that cannot answer is not proof of anything: say nothing rather than cry wolf.
    Effect.catchAll(() => Effect.succeed({ gone: false })),
  );

const startEffect = (change: Change): Effect.Effect<Running, CliError> =>
  Effect.gen(function* () {
    // Fail on a missing tool before spawning, with the fix in the message: an ENOENT from the
    // spawn itself surfaces as a bare "Load failed" in the browser, which is no way to learn that
    // a package install is all that is wanted.
    if (!commandAvailable("ttyd")) return yield* Effect.fail(missingTool("ttyd"));
    if (!commandAvailable("tmux")) return yield* Effect.fail(missingTool("tmux"));
    // Only reached when no ttyd could be adopted, so anything still running for this change is a
    // leftover that nothing can reach: a port nothing remembers, or a process that stopped
    // answering. The tmux session behind it survives either way — and must: killing the ttyd
    // detaches the session, it does not end it, and the next ttyd attaches to the same windows.
    //
    // Anchored to `ttyd`, because the tmux server's own command line also starts with `tmux
    // new-session -A -s <session>`: unanchored, this pattern matched the server itself and killed
    // the session — every window and every shell in it — instead of the stale process serving it.
    yield* shResult(["pkill", "-f", `^ttyd .*new-session -A -s ${sessionName(change.id)}`]);

    const port = freePort();
    // Detached so a server reload does not take your shells with it. Its output goes to a log
    // rather than /dev/null: when a terminal comes up blank, ttyd's own words are the fastest
    // way to find out why.
    const child = yield* Effect.try<ChildProcess, CliError>({
      try: () => {
        const logFd = openSync(logPath(change.id), "a");
        const child = spawn(
          "ttyd",
          [
            "--writable",
            "--interface",
            // Loopback by interface name (lo0 on macOS, lo on Linux): this is a shell, it has no
            // business on the network.
            loopbackInterface,
            "--port",
            String(port),
            "-t",
            // The terminal scrolls with tmux's mouse mode, and tmux repaints in place rather than
            // scrolling the outer terminal, so xterm's own scrollback is never what you scroll and
            // its scrollbar is only ever an empty bar down the right edge. Zero removes it, and
            // removes the width the fit addon otherwise reserves for it.
            //
            // Before fontSize, deliberately: ttyd re-fits the terminal only when a font* option is
            // applied, and that fit asks whether scrollback is zero to decide what width it has to
            // work with. With this after fontSize, the fit would have already run with the default
            // scrollback and the reserved bar would be back.
            "scrollback=0",
            "-t",
            "fontSize=13",
            "-t",
            'theme={"background":"#0d1117","foreground":"#e6edf3"}',
            // With tmux's mouse mode on, the mouse belongs to tmux and dragging never reaches the
            // browser. xterm.js can be told to hand it back while a modifier is held — on macOS that
            // modifier is option, and only if this is switched on. Without it there is no way to
            // select text for the system clipboard at all. The flag is meaningless elsewhere, where
            // plain drag selection already reaches the clipboard, so it is macOS-only.
            ...(isMac ? ["-t", "macOptionClickForcesSelection=true"] : []),
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
          { detached: true, stdio: ["ignore", logFd, logFd] },
        );
        child.unref();
        closeSync(logFd); // ttyd holds its own copy now
        return child;
      },
      catch: (e) =>
        cliError("ttyd", "ttyd", e instanceof Error ? e.message : String(e), 1),
    });
    // A spawn that failed outright (the binary vanished between the check and now, say) must be
    // the reported cause rather than a five-second timeout: listen for it and race it against the
    // port. After the port opens the listener is dead weight — a reject on a settled promise is a
    // no-op, and it keeps the event from arriving unhandled.
    yield* Effect.tryPromise<void, CliError>({
      try: () =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          listening(port).then(resolve, reject);
        }),
      catch: (e) => cliError("ttyd", "ttyd", e instanceof Error ? e.message : String(e), 1),
    });
    const found = { port, pid: child.pid!, at: Date.now() };
    yield* Effect.tryPromise({
      try: () => Bun.write(notePath(change.id), JSON.stringify(found) + "\n").then(() => undefined),
      catch: (e) => cliError("ttyd", "ttyd", e instanceof Error ? e.message : String(e), 1),
    });
    return found;
  });

const missingTool = (tool: string): CliError => {
  const message = `${tool} is not installed — the terminal cannot start (Arch: sudo pacman -S ${tool}${
    isMac ? `; macOS: brew install ${tool}` : ""
  })`;
  return cliError(tool, tool, message, 127);
};

/** Whether something accepts connections on this port. A plain TCP connect, not an HTTP request:
 * this only has to answer "is it open", and an HTTP client brings a connection pool and timeouts
 * of its own to a question that simple. */
const acceptsEffect = (port: number): Effect.Effect<boolean> =>
  Effect.promise(() =>
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
    ),
  );

/** ttyd needs a moment to bind. Returning before it does hands the browser a URL that refuses
 * the connection, and an iframe does not retry: it just sits there empty. */
const listeningEffect = (port: number): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (yield* acceptsEffect(port)) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.fail(
      cliError("ttyd", "ttyd", `ttyd did not open port ${port} within 5s; see /tmp/iwe-ttyd-*.log`, 1),
    );
  });

/** The Effect above as a promise: the spawn-error race settles on it, and a reject after it
 * settles is a no-op. */
const listening = (port: number): Promise<void> =>
  listeningEffect(port).pipe(Effect.runPromise) as Promise<void>;

/** Drop the terminal of a change: the ttyd server and the tmux session with its shells. Called
 * when a change is completed, since its directory moves into the archive underneath it. */
export const stopTerminal = (id: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const inFlight = running.get(id);
    const fromMap = inFlight ? yield* Effect.exit(Deferred.await(inFlight)) : undefined;
    const found =
      (fromMap && Exit.isSuccess(fromMap) ? fromMap.value : undefined) ?? (yield* noteOfEffect(id));
    if (found && alive(found.pid)) process.kill(found.pid);
    running.delete(id);
    yield* shResult(["tmux", "kill-session", "-t", sessionName(id)]);
  });


/* Terminals are deliberately left running when the server stops: restarting IWE while you work on
 * it is constant, and losing the shells every time is not worth the tidiness. They are noted in
 * the change directory and adopted again on the next start; completing a change ends one for
 * good, and so does closing its last window. */

/** Shells: a window sitting at a prompt is idle, whatever the shell is called. */
const SHELLS = ["zsh", "bash", "sh", "fish", "-zsh", "-bash", "tmux"];

/** One tmux window as the page sees it, with the busy fact the overview counts — presentational
 * to the page, but the server's own accounting travels with it too. */
export type PresentedWindow = TerminalWindow & { busy: boolean };

/** The pane options any presenter declared, once each, in load order — the FORMAT asks tmux
 * for exactly these, so the raw window carries what presenters know how to read. */
const paneOptions = (): string[] => {
  const seen = new Set<string>();
  for (const presenter of windowPresenters()) {
    for (const option of presenter.paneOptions ?? []) seen.add(option);
  }
  return [...seen];
};

/** The tmux FORMAT for a set of pane options: the fixed fields, then one field per option.
 * Built per call, because the options depend on which extensions are loaded. `list-windows`
 * still answers in one call per session. */
const formatFor = (options: readonly string[]): string => {
  const fixed =
    "#{window_index}\t#{window_name}\t#{pane_current_command}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{automatic-rename}\t#{window_id}";
  return options.length ? `${fixed}\t${options.map((o) => `#{${o}}`).join("\t")}` : fixed;
};

const parseWindow = (line: string, options: readonly string[]): TmuxWindow => {
  const [index, name, command, active, activity, path, auto, id, ...extra] = line.split("\t");
  const opts: Record<string, string> = {};
  extra.forEach((value, i) => {
    const option = options[i];
    if (option) opts[option] = value ?? "";
  });
  return {
    index: Number(index),
    id: id ?? "",
    name: name ?? "",
    command: command ?? "",
    active: active === "1",
    activity: activity === "1",
    directory: basename(path ?? ""),
    named: auto === "0",
    options: opts,
  };
};

/** What the merge has gathered from the presenters before the core's defaults compose it:
 * fields the presenters left undefined fall through to later presenters, then to here. */
const merged = (raw: TmuxWindow): WindowPresentation =>
  windowPresenters().reduce<WindowPresentation>((acc, presenter) => {
    const answer = presenter.present(raw);
    if (!answer) return acc; // a presenter with nothing to say contributes nothing
    return {
      label: acc.label ?? answer.label,
      running: acc.running ?? answer.running,
      detail: acc.detail ?? answer.detail,
      icon: acc.icon ?? answer.icon,
      state: acc.state ?? answer.state,
      busy: acc.busy ?? answer.busy,
      attention: acc.attention ?? answer.attention,
      note: acc.note ?? answer.note,
    };
  }, {});

/**
 * Present one raw window: ask the presenters what it is, and compose the core's defaults
 * around whatever they answered.
 *
 * The first presenter that answers a field wins (registration order within an extension, load
 * order across them); what nobody answered, the core says:
 *
 * - the base name is the name you gave the window, or where it is — tmux's own default names
 *   a window after whatever runs in it, which says less than the directory does;
 * - the composed name appends what is running, unless it is a plain shell or already the
 *   whole label — so a prompt reads as a place, not a program;
 * - busy is "not a shell" — the heuristic the overview's terminals fact uses, with an agent
 *   believed over its process name (pi at its prompt is `node`).
 *
 * Pure, and exported for the tests: the page renders exactly what this says.
 */
export const presentWindow = (raw: TmuxWindow): PresentedWindow => {
  const said = merged(raw);
  const base = raw.named ? raw.name : raw.directory || raw.name;
  const what = said.running ?? raw.command;
  const label = said.label ?? (what && what !== "zsh" && what !== base ? `${base} - (${what})` : base);
  return {
    index: raw.index,
    id: raw.id,
    label,
    detail: said.detail ?? `${raw.name} (${raw.command}) in ${raw.directory}`,
    icon: said.icon ?? "terminal",
    state: said.state ?? "idle",
    active: raw.active,
    activity: raw.activity,
    attention: said.attention ?? false,
    note: said.note,
    busy: said.busy ?? (Boolean(raw.command) && !SHELLS.includes(raw.command)),
  };
};

/** The windows of one change's session, presented. No session yet — the terminal was never
 * opened — is an empty strip, not a failure; the `CliError` channel is only for a timed-out
 * tmux. */
export const listWindows = (id: string): Effect.Effect<PresentedWindow[], CliError> =>
  Effect.gen(function* () {
    const options = paneOptions();
    const r = yield* sh(["tmux", "list-windows", "-t", sessionName(id), "-F", formatFor(options)]);
    if (r.code !== 0) return []; // no session yet: the terminal was never opened
    return r.stdout.split("\n").filter(Boolean).map((line) => presentWindow(parseWindow(line, options)));
  });


/** Which change a tmux session belongs to, or undefined for a session that is not ours. */
export const changeOfSession = (session: string): string | undefined =>
  session.startsWith("iwe-") ? session.slice("iwe-".length) : undefined;

/**
 * Every change's windows, in one call.
 *
 * The navigation column lists the terminals of every change at once, and asking tmux per change
 * would be a process per change every few seconds. `list-windows -a` answers for every session
 * there is; the ones that are not ours are dropped by their name. No tmux server running is an
 * empty record, not a failure; the `CliError` channel is only for a timed-out tmux.
 */
export const allWindows = (): Effect.Effect<Record<string, PresentedWindow[]>, CliError> =>
  Effect.gen(function* () {
    const options = paneOptions();
    const r = yield* sh(["tmux", "list-windows", "-a", "-F", `#{session_name}\t${formatFor(options)}`]);
    if (r.code !== 0) return {}; // no server running: nobody has opened a terminal yet
    const byChange: Record<string, PresentedWindow[]> = {};
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const tab = line.indexOf("\t");
      const id = changeOfSession(line.slice(0, tab));
      if (!id) continue;
      (byChange[id] ??= []).push(presentWindow(parseWindow(line.slice(tab + 1), options)));
    }
    return byChange;
  });

/**
 * A new window beside the current one, starting where the current one is: a new tab is nearly
 * always "the same place, another thing", and `#{pane_current_path}` is what tmux's own `c`
 * binding uses. Falls back to the change directory when there is no current pane to ask.
 */
export const newWindow = (id: string): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const here = yield* sh([
      "tmux",
      "new-window",
      "-t",
      sessionName(id),
      "-c",
      "#{pane_current_path}",
    ]);
    if (here.code === 0) return;
    yield* shOrThrow(["tmux", "new-window", "-t", sessionName(id), "-c", changeDir(id)]);
  });


export const selectWindow = (id: string, index: number): Effect.Effect<void, CliError> =>
  shOrThrow(["tmux", "select-window", "-t", `${sessionName(id)}:${index}`]).pipe(
    Effect.asVoid,
  );

/**
 * Put a window where another one is, shifting the windows in between. tmux's own move-window
 * refuses an occupied index, so this is a walk of swaps along the session's actual indices —
 * which may have gaps where a window was closed. The current window follows the move, wherever
 * it is in the shuffle.
 */
export const moveWindow = (id: string, from: number, to: number): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (from === to) return;
    const listed = yield* shOrThrow([
      "tmux",
      "list-windows",
      "-t",
      sessionName(id),
      "-F",
      "#{window_index}",
    ]);
    const indexes = listed.split("\n").filter(Boolean).map(Number);
    const start = indexes.indexOf(from);
    const end = indexes.indexOf(to);
    if (start === -1 || end === -1) return; // a window that has gone since the drag began
    const step = start < end ? 1 : -1;
    for (let i = start; i !== end; i += step) {
      yield* shOrThrow([
        "tmux",
        "swap-window",
        "-s",
        `${sessionName(id)}:${indexes[i]}`,
        "-t",
        `${sessionName(id)}:${indexes[i + step]}`,
      ]);
    }
  });

