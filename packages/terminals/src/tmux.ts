/**
 * A terminal for a change: one tmux session, started in the change directory.
 *
 * tmux owns the session, not us. Windows and panes are yours to make with the usual keys, the
 * shells survive a Corvi restart, and `tmux -L <name> attach -t <name>-<id>` from any terminal
 * reaches the same session as the browser does — the socket is the host's own (see `Command`
 * below), so the command has to name it.
 *
 * This file is the tmux half: how a client attaches, what the windows are, and the cleanup. The
 * pty that runs the attach command belongs to `session.ts`, so this module stays a set of CLI
 * calls and pure presentation.
 *
 * How commands run, what the product is called, and what its environment variables look like
 * come from the `Host` the app supplies to `make`, so this module never reads the environment
 * itself and the app's process layer stays the only one that does.
 */
import { Effect } from "effect";

import type { TmuxWindow } from "@corvi/contracts/terminal";
import {
  COMMAND_ACTION_OPTION,
  COMMAND_EXIT_OPTION,
  COMMAND_NOTIFY_OPTION,
} from "./model.ts";

/** One tmux command's outcome, as the process layer reports it. Exit codes are data: no
 * session and no server are normal answers here. */
export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** A tmux command that did not complete: it timed out or could not start, or — through
 * `runOrThrow` — exited nonzero. `message` is the app's own CLI failure text, carried verbatim
 * so the package never invents wording; the fields are what that failure already had. */
export type CommandFailure = {
  readonly message: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/** What the tmux code needs from the process that owns it: how to run a command, and the
 * product's names. */
export type Host = {
  /** Run a tmux command. Non-zero exits succeed with their code; only a timeout or a command
   * that could not start fails. */
  readonly run: (args: readonly string[]) => Effect.Effect<CommandResult, CommandFailure>;
  /** Run a tmux command, failing when it exits nonzero, for actions the user should see. */
  readonly runOrThrow: (args: readonly string[]) => Effect.Effect<CommandResult, CommandFailure>;
  /** The tmux socket this instance's sessions live on: a name (`-L`) or a path (`-S`). */
  readonly socket: string;
  /** The product's short name: the session prefix and the buffer prefix. */
  readonly name: string;
  /** One of the product's environment variables by suffix. */
  readonly env: (suffix: string) => string;
};

/** What a window running one command does when it ends. `keepOpen` freezes the pane over its
 * output (`remain-on-exit`) instead of closing the window with it; `announce` records what ran
 * and how it ended in the pane options `commandWindowPresenter` reads, with `notify` marking the
 * ending as wanting the user. The wrapper that does this sets `remain-on-exit` first — a fast
 * command can end before an option set afterwards would ever reach it. */
export type NewWindowOptions = {
  readonly keepOpen: boolean;
  readonly announce?: {
    readonly label: string;
    readonly notify: boolean;
  };
};

/** The tmux operations the app binds to its own process layer. */
export type Sessions = {
  readonly sessionName: (id: string) => string;
  readonly terminalSocketPath: (id: string) => string;
  readonly attachCommand: (id: string, dir: string) => string[];
  readonly stopTerminal: (id: string) => Effect.Effect<void>;
  readonly windows: (id: string, options: readonly string[]) => Effect.Effect<TmuxWindow[], CommandFailure>;
  readonly allWindows: (
    options: readonly string[],
  ) => Effect.Effect<Record<string, TmuxWindow[]>, CommandFailure>;
  readonly changeOfSession: (session: string) => string | undefined;
  readonly newWindow: (id: string, dir: string) => Effect.Effect<void, CommandFailure>;
  readonly selectWindow: (id: string, index: number) => Effect.Effect<void, CommandFailure>;
  readonly moveWindow: (id: string, from: number, to: number) => Effect.Effect<void, CommandFailure>;
  readonly ensureSession: (id: string, dir: string) => Effect.Effect<void, CommandFailure>;
  /** A bracketed paste into one window's active pane — so a multi-line prompt lands in the
   * editor whole rather than being executed line by line — without submitting it: Corvi cannot
   * tell a running agent from a shell, and submitting a paragraph to a shell would run it. The
   * user reads it and sends it, which is the one keystroke worth keeping. `@3` is tmux's own
   * window id, stable across the reordering the tabs do. */
  readonly pastePromptTo: (window: string, text: string) => Effect.Effect<void, CommandFailure>;
  /** The one keystroke Corvi keeps for you: Enter, into that pane. */
  readonly submit: (window: string) => Effect.Effect<void, CommandFailure>;
  /** A new window running one command — the window a command action gets. Returns the new
   * window's tmux id, so a paste can follow it immediately. */
  readonly newWindowRunning: (
    id: string,
    dir: string,
    command: string,
    options: NewWindowOptions,
  ) => Effect.Effect<string, CommandFailure>;
};

/** The tmux FORMAT for a set of pane options: the fixed fields, then one field per option.
 * Built per call, because the options depend on which presenters exist. `list-windows` still
 * answers in one call per session. */
export const formatFor = (options: readonly string[]): string => {
  const fixed =
    "#{window_index}\t#{window_name}\t#{pane_current_command}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{automatic-rename}\t#{window_id}";
  return options.length ? `${fixed}\t${options.map((o) => `#{${o}}`).join("\t")}` : fixed;
};

/** The last segment of a POSIX path. tmux reports POSIX paths whatever the client runs on, so
 * this deliberately does not ask the platform. */
const directoryOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/** One line of the FORMAT above, as the raw window the presenters read. */
export const parseWindow = (line: string, options: readonly string[]): TmuxWindow => {
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
    directory: directoryOf(path ?? ""),
    named: auto === "0",
    options: opts,
  };
};

/** Bind the tmux operations to the host's process layer. */
export const make = (host: Host): Sessions => {
  const sessionName = (id: string): string => `${host.name}-${id}`;

  /** Every tmux command Corvi runs goes through here: the socket is part of the command, not
   * something each caller has to remember. `-L` and `-S` beat `$TMUX` (verified: with `$TMUX`
   * set, `tmux -L x ls` still asks the x socket), so the app cannot be rerouted by whatever
   * shell it was started from — and a bare `tmux` typed anywhere outside a pane can no longer
   * reach these sessions at all. */
  const tmuxCmd = (args: readonly string[]): string[] => [
    "tmux",
    ...(host.socket.includes("/") ? ["-S", host.socket] : ["-L", host.socket]),
    ...args,
  ];

  const terminalSocketPath = (id: string): string =>
    `/api/changes/${encodeURIComponent(id)}/terminal/socket`;

  /** The argv a pty attaches the change's session with: create it if it is not there, then the
   * options the session runs under. One place owns these, so the pty only has to know how to run
   * a command in a pseudoterminal. */
  const attachCommand = (id: string, dir: string): string[] =>
    tmuxCmd([
      "new-session",
      "-A", // attach if it exists, create if it does not
      "-s",
      sessionName(id),
      "-c",
      dir,
      // A scroll wheel should scroll, not walk back through your shell history. Scoped to this
      // session with -t, so tmux sessions you started yourself keep your own settings.
      // -q on all of them: an option a tmux version does not know (extended-keys-format is
      // tmux 3.5+; Ubuntu 24.04 ships 3.4) must not fail the client that is holding the attach
      // open — a non-zero exit there detaches the pty, and the later options never run.
      ";",
      "set-option",
      "-q",
      "-t",
      sessionName(id),
      "mouse",
      "on",
      // Windows that produced output since you last looked at them are flagged, which is what the
      // strip above the terminal draws a dot for.
      ";",
      "set-option",
      "-q",
      "-t",
      sessionName(id),
      "monitor-activity",
      "on",
      // The flag is the point; the message across the status bar is not.
      ";",
      "set-option",
      "-q",
      "-t",
      sessionName(id),
      "visual-activity",
      "off",
      // Modified Enter and friends only reach an application when tmux is willing to forward them,
      // in the encoding the page sends (CSI u). A server option: tmux keeps one set of these for
      // every session it runs, ours included.
      ";",
      "set-option",
      "-q",
      "-s",
      "extended-keys",
      "on",
      ";",
      "set-option",
      "-q",
      "-s",
      "extended-keys-format",
      "csi-u",
      // tmux's own copies — a drag, a double click, an explicit copy command — go to the outer
      // terminal as an OSC 52 sequence, which the page turns into a system-clipboard write
      // (TerminalPane.tsx). A server option, like the extended-keys pair: tmux keeps one clipboard
      // policy for every session it runs, ours included.
      ";",
      "set-option",
      "-q",
      "-s",
      "set-clipboard",
      "on",
      // A client whose terminfo has no `Ms` capability would get no OSC 52 from `set-clipboard`
      // alone; terminal-features grants it by name. Guarded by what the client actually resolved,
      // so the list cannot grow an entry per attach — this runs after `new-session -A`, where the
      // client exists to ask. The pty's TERM (xterm-256color) is already covered by tmux's own
      // defaults, so it only fires for a client those do not cover, and takes effect there from
      // its next attach.
      ";",
      "if-shell",
      "-F",
      "#{m/r:clipboard,#{client_termfeatures}}",
      "",
      'set -q -as terminal-features ",*:clipboard"',
    ]);

  /** Drop the terminal of a change: the tmux session and the shells in it. Called when a change
   * is completed, since its directory moves into the archive underneath it.
   *
   * The ptys attached to the session are the server's children, and they exit when the session
   * they are attached to is destroyed — so ending the session is the whole cleanup. A tmux that
   * timed out is not worth failing a completion over. */
  const stopTerminal = (id: string): Effect.Effect<void> =>
    host.run(tmuxCmd(["kill-session", "-t", sessionName(id)])).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void));

  /* Terminals are deliberately left running when the server stops: restarting Corvi while you work on
   * it is constant, and losing the shells every time is not worth the tidiness. tmux owns them, so
   * the next run attaches to the same windows; completing a change ends one for good. */

  /** The windows of one change's session, raw. No session yet — the terminal was never
   * opened — is an empty strip, not a failure; the failure channel is only for a timed-out
   * tmux. */
  const windows = (id: string, options: readonly string[]): Effect.Effect<TmuxWindow[], CommandFailure> =>
    Effect.gen(function* () {
      const r = yield* host.run(tmuxCmd(["list-windows", "-t", sessionName(id), "-F", formatFor(options)]));
      if (r.code !== 0) return []; // no session yet: the terminal was never opened
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => parseWindow(line, options));
    });

  /** Which change a tmux session belongs to, or undefined for a session that is not ours. */
  const changeOfSession = (session: string): string | undefined =>
    session.startsWith(`${host.name}-`) ? session.slice(host.name.length + 1) : undefined;

  /** Every change's windows, in one call, raw.
   *
   * The navigation column lists the terminals of every change at once, and asking tmux per change
   * would be a process per change every few seconds. `list-windows -a` answers for every session
   * there is; the ones that are not ours are dropped by their name. No tmux server running is an
   * empty record, not a failure; the failure channel is only for a timed-out tmux. */
  const allWindows = (options: readonly string[]): Effect.Effect<Record<string, TmuxWindow[]>, CommandFailure> =>
    Effect.gen(function* () {
      const r = yield* host.run(tmuxCmd(["list-windows", "-a", "-F", `#{session_name}\t${formatFor(options)}`]));
      if (r.code !== 0) return {}; // no server running: nobody has opened a terminal yet
      const byChange: Record<string, TmuxWindow[]> = {};
      for (const line of r.stdout.split("\n").filter(Boolean)) {
        const tab = line.indexOf("\t");
        const id = changeOfSession(line.slice(0, tab));
        if (!id) continue;
        (byChange[id] ??= []).push(parseWindow(line.slice(tab + 1), options));
      }
      return byChange;
    });

  /** A new window beside the current one, starting where the current one is: a new tab is nearly
   * always "the same place, another thing", and `#{pane_current_path}` is what tmux's own `c`
   * binding uses. Falls back to the change directory when there is no current pane to ask. */
  const newWindow = (id: string, dir: string): Effect.Effect<void, CommandFailure> =>
    Effect.gen(function* () {
      const here = yield* host.run(tmuxCmd(["new-window", "-t", sessionName(id), "-c", "#{pane_current_path}"]));
      if (here.code === 0) return;
      yield* host.runOrThrow(tmuxCmd(["new-window", "-t", sessionName(id), "-c", dir]));
    });

  const selectWindow = (id: string, index: number): Effect.Effect<void, CommandFailure> =>
    host.runOrThrow(tmuxCmd(["select-window", "-t", `${sessionName(id)}:${index}`])).pipe(Effect.asVoid);

  /** Make sure the change's tmux session exists, so something can be written into it before a
   * browser has opened the terminal. `new-session -A` attaches to an existing one, so this is
   * compatible with the pty that attaches it: it only ever creates the session the pty would have
   * created on connection, with the change directory as its cwd.
   *
   * Detached, because nobody is looking yet; the options the attach command sets still run when
   * a pty attaches. */
  const ensureSession = (id: string, dir: string): Effect.Effect<void, CommandFailure> =>
    Effect.gen(function* () {
      const has = yield* host.run(tmuxCmd(["has-session", "-t", sessionName(id)]));
      if (has.code === 0) return;
      // -e sets the *session* environment at creation, so the shell in the first window starts with
      // the change's context — the same one a pty-created session inherits from its client
      // (apps/server/src/capabilities/env.ts). Without it, a session created here would keep this server
      // process's environment and no change context for every pane it ever grows.
      yield* host.runOrThrow(
        tmuxCmd([
          "new-session",
          "-d",
          "-s",
          sessionName(id),
          "-c",
          dir,
          "-e",
          `${host.env("CHANGE_ID")}=${id}`,
          "-e",
          `${host.env("CHANGE_DIR")}=${dir}`,
        ]),
      );
    });

  /** A bracketed paste into one window's active pane. The buffer is per window, so two pastes
   * into two windows close together cannot take each other's text between load and paste. */
  const pastePromptTo = (window: string, text: string): Effect.Effect<void, CommandFailure> =>
    Effect.gen(function* () {
      const buffer = `${host.name}-prompt-${window.replace(/[^A-Za-z0-9]/g, "")}`;
      // `--` so a prompt that begins with a dash is data, not an option.
      yield* host.runOrThrow(tmuxCmd(["set-buffer", "-b", buffer, "--", text]));
      yield* host.runOrThrow(tmuxCmd(["paste-buffer", "-p", "-b", buffer, "-t", window]));
      yield* host.runOrThrow(tmuxCmd(["delete-buffer", "-b", buffer]));
    });

  /** Enter into one window's active pane: what `submit` on an action asks for. */
  const submit = (window: string): Effect.Effect<void, CommandFailure> =>
    host.runOrThrow(tmuxCmd(["send-keys", "-t", window, "Enter"])).pipe(Effect.asVoid);

  /** POSIX single-quote wrapping: whatever a label or a socket name contains, it is data to the
   * shell that runs the wrapper. */
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

  /** The wrapper's own tmux, addressing the right socket from inside the pane. */
  const tmuxInPane = (args: string): string =>
    `tmux ${host.socket.includes("/") ? "-S" : "-L"} ${shellQuote(host.socket)} ${args}`;

  /** A command through the announcing wrapper: run the body, then say how it ended. The body
   * runs in a subshell, so an `exit` in it ends the run rather than the wrapper that records how
   * it ended — `exit` is a perfectly ordinary last line in a command. The syntax is POSIX sh, as
   * the rest of the wrapper's is. The pane options are the package's own vocabulary
   * (`@corvi/terminals/model`); `$TMUX_PANE` survives in the pane's environment exactly so a
   * tool can address its own pane (capabilities/env.ts). */
  const wrapped = (command: string, announce: NewWindowOptions["announce"]): string =>
    [
      tmuxInPane(`set-option -q -w -t "$TMUX_PANE" remain-on-exit on`),
      ...(announce
        ? [tmuxInPane(`set-option -q -p -t "$TMUX_PANE" ${COMMAND_ACTION_OPTION} ${shellQuote(announce.label)}`)]
        : []),
      ...(announce?.notify
        ? [tmuxInPane(`set-option -q -p -t "$TMUX_PANE" ${COMMAND_NOTIFY_OPTION} 1`)]
        : []),
      // The leading `:` keeps the subshell a valid command with an empty body.
      `( :\n${command}\n)`,
      "__corvi_exit=$?",
      tmuxInPane(`set-option -q -p -t "$TMUX_PANE" ${COMMAND_EXIT_OPTION} "$__corvi_exit"`),
      'exit "$__corvi_exit"',
    ].join("\n");

  /** A new window running one command. `#{pane_current_path}` first, like `newWindow`, falling
   * back to the change directory — and `#{window_id}` out, because a paste follows immediately
   * and needs the window it just made. `-P` is what makes `new-window` print at all (`-F` only
   * says what); without it the id comes back empty and the window is made twice. Without
   * `keepOpen` and `announce` the body is the window's own shell command and the window goes
   * when it ends; with either, it runs through the wrapper above. */
  const newWindowRunning = (
    id: string,
    dir: string,
    command: string,
    options: NewWindowOptions,
  ): Effect.Effect<string, CommandFailure> =>
    Effect.gen(function* () {
      const body = options.keepOpen || options.announce ? wrapped(command, options.announce) : command;
      const args = (at: string): string[] => ["new-window", "-P", "-F", "#{window_id}", "-t", sessionName(id), "-c", at, body];
      const here = yield* host.run(tmuxCmd(args("#{pane_current_path}")));
      const window = here.code === 0 ? here.stdout.trim() : "";
      if (window) return window;
      const fallback = yield* host.runOrThrow(tmuxCmd(args(dir)));
      return fallback.stdout.trim();
    });

  /** Put a window where another one is, shifting the windows in between. tmux's own move-window
   * refuses an occupied index, so this is a walk of swaps along the session's actual indices —
   * which may have gaps where a window was closed. The current window follows the move, wherever
   * it is in the shuffle. */
  const moveWindow = (id: string, from: number, to: number): Effect.Effect<void, CommandFailure> =>
    Effect.gen(function* () {
      if (from === to) return;
      const listed = yield* host.runOrThrow(
        tmuxCmd(["list-windows", "-t", sessionName(id), "-F", "#{window_index}"]),
      );
      const indexes = listed.stdout.split("\n").filter(Boolean).map(Number);
      const start = indexes.indexOf(from);
      const end = indexes.indexOf(to);
      if (start === -1 || end === -1) return; // a window that has gone since the drag began
      const step = start < end ? 1 : -1;
      for (let i = start; i !== end; i += step) {
        yield* host.runOrThrow(
          tmuxCmd([
            "swap-window",
            "-s",
            `${sessionName(id)}:${indexes[i]}`,
            "-t",
            `${sessionName(id)}:${indexes[i + step]}`,
          ]),
        );
      }
    });

  return {
    sessionName,
    terminalSocketPath,
    attachCommand,
    stopTerminal,
    windows,
    allWindows,
    changeOfSession,
    newWindow,
    newWindowRunning,
    selectWindow,
    moveWindow,
    ensureSession,
    pastePromptTo,
    submit,
  };
};
