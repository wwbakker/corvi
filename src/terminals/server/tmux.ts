import { Effect } from "effect";
import { sh, shOrThrow, type Result } from "../../capabilities/shell.ts";
import { CliError } from "../../capabilities/effect/errors.ts";
import {
  formatFor,
  paneOptions,
  parseWindow,
  presentWindow,
  type PresentedWindow,
} from "./presenter.ts";

/**
 * A terminal for a change: one tmux session, started in the change directory.
 *
 * tmux owns the session, not us. Windows and panes are yours to make with the usual keys, the
 * shells survive an IWE restart, and `tmux -L iwe attach -t iwe-<id>` from any terminal reaches
 * the same session as the browser does — the socket is IWE's own (tmuxCmd below), so the command
 * has to name it.
 *
 * This file is the tmux half: how a client attaches, what the windows are, and the cleanup.
 * The pty that runs the attach command belongs to `session.ts`, so this module stays a set of
 * CLI calls and pure presentation.
 */
export const sessionName = (id: string): string => `iwe-${id}`;

/** The tmux socket IWE's sessions live on: a bare name becomes `-L <name>` (the socket file
 * `tmux-<uid>/<name>` under `$TMUX_TMPDIR` or /tmp), a path becomes `-S <path>`. Overridable so a
 * test run or a sandbox copy can name its own — the tests pass the same value to their own tmux
 * calls through the same variable. */
const socket = (): string => process.env.IWE_TMUX_SOCKET || "iwe";

/** Every tmux command IWE runs goes through here: the socket is part of the command, not
 * something each caller has to remember. `-L` and `-S` beat `$TMUX` (verified: with `$TMUX` set,
 * `tmux -L x ls` still asks the x socket), so the app cannot be rerouted by whatever shell it was
 * started from — and a bare `tmux` typed anywhere outside a pane can no longer reach these
 * sessions at all. */
const tmuxCmd = (args: string[]): string[] => [
  "tmux",
  ...(socket().includes("/") ? ["-S", socket()] : ["-L", socket()]),
  ...args,
];

/** Where the page opens the terminal's socket, on the server's own origin. The pane appends its
 * size as query parameters; every connection is one tmux client (session.ts). */
export const terminalSocketPath = (id: string): string =>
  `/api/changes/${encodeURIComponent(id)}/terminal/socket`;

/** The argv a pty attaches the change's session with: create it if it is not there, then the
 * options the session runs under. One place owns these, so the pty only has to know how to run
 * a command in a pseudoterminal. */
export const attachCommand = (id: string, dir: string): string[] =>
  tmuxCmd([
    "new-session",
    "-A", // attach if it exists, create if it does not
    "-s",
    sessionName(id),
    "-c",
    dir,
    // A scroll wheel should scroll, not walk back through your shell history. Scoped to this
    // session with -t, so tmux sessions you started yourself keep your own settings.
    ";",
    "set-option",
    "-t",
    sessionName(id),
    "mouse",
    "on",
    // Windows that produced output since you last looked at them are flagged, which is what the
    // strip above the terminal draws a dot for.
    ";",
    "set-option",
    "-t",
    sessionName(id),
    "monitor-activity",
    "on",
    // The flag is the point; the message across the status bar is not.
    ";",
    "set-option",
    "-t",
    sessionName(id),
    "visual-activity",
    "off",
    // Modified Enter and friends only reach an application when tmux is willing to forward them,
    // in the encoding the page sends (CSI u). A server option: tmux keeps one set of these for
    // every session it runs, ours included.
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
    // tmux's own copies — a drag, a double click, an explicit copy command — go to the outer
    // terminal as an OSC 52 sequence, which the page turns into a system-clipboard write
    // (TerminalPane.tsx). A server option, like the extended-keys pair: tmux keeps one clipboard
    // policy for every session it runs, ours included.
    ";",
    "set-option",
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
    'set -as terminal-features ",*:clipboard"',
  ]);

/** The Result-branching contract: the one failure `sh` can raise here is a timeout, which
 * surfaces as a failed command (exit code 124) rather than a failure of the operation, so
 * everything downstream branches on `code`. */
const shResult = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  sh(cmd, cwd).pipe(
    Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
  );

/** Drop the terminal of a change: the tmux session and the shells in it. Called when a change
 * is completed, since its directory moves into the archive underneath it.
 *
 * The ptys attached to the session are the server's children, and they exit when the session
 * they are attached to is destroyed — so ending the session is the whole cleanup. */
export const stopTerminal = (id: string): Effect.Effect<void> =>
  shResult(tmuxCmd(["kill-session", "-t", sessionName(id)])).pipe(Effect.asVoid);

/* Terminals are deliberately left running when the server stops: restarting IWE while you work on
 * it is constant, and losing the shells every time is not worth the tidiness. tmux owns them, so
 * the next run attaches to the same windows; completing a change ends one for good. */

/** The windows of one change's session, presented. No session yet — the terminal was never
 * opened — is an empty strip, not a failure; the `CliError` channel is only for a timed-out
 * tmux. */
export const listWindows = (id: string): Effect.Effect<PresentedWindow[], CliError> =>
  Effect.gen(function* () {
    const options = paneOptions();
    const r = yield* sh(tmuxCmd(["list-windows", "-t", sessionName(id), "-F", formatFor(options)]));
    if (r.code !== 0) return []; // no session yet: the terminal was never opened
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => presentWindow(parseWindow(line, options)));
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
    const r = yield* sh(
      tmuxCmd([
        "list-windows",
        "-a",
        "-F",
        `#{session_name}\t${formatFor(options)}`,
      ]),
    );
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
export const newWindow = (id: string, dir: string): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const here = yield* sh(
      tmuxCmd(["new-window", "-t", sessionName(id), "-c", "#{pane_current_path}"]),
    );
    if (here.code === 0) return;
    yield* shOrThrow(tmuxCmd(["new-window", "-t", sessionName(id), "-c", dir]));
  });

export const selectWindow = (id: string, index: number): Effect.Effect<void, CliError> =>
  shOrThrow(tmuxCmd(["select-window", "-t", `${sessionName(id)}:${index}`])).pipe(Effect.asVoid);

/**
 * Make sure the change's tmux session exists, so something can be written into it before a
 * browser has opened the terminal. `new-session -A` attaches to an existing one, so this is
 * compatible with the pty that attaches it: it only ever creates the session the pty would have
 * created on connection, with the change directory as its cwd.
 *
 * Detached, because nobody is looking yet; the options the attach command sets still run when
 * a pty attaches.
 */
export const ensureSession = (id: string, dir: string): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const has = yield* sh(tmuxCmd(["has-session", "-t", sessionName(id)]));
    if (has.code === 0) return;
    // -e sets the *session* environment at creation, so the shell in the first window starts with
    // the change's context — the same one a pty-created session inherits from its client
    // (session.ts, src/capabilities/env.ts). Without it, a session created here would keep this
    // server process's environment and no change context for every pane it ever grows.
    yield* shOrThrow(
      tmuxCmd([
        "new-session",
        "-d",
        "-s",
        sessionName(id),
        "-c",
        dir,
        "-e",
        `IWE_CHANGE_ID=${id}`,
        "-e",
        `IWE_CHANGE_DIR=${dir}`,
      ]),
    );
  });

/**
 * Paste a prompt into the change's terminal, at its active pane, without submitting it: a
 * bracketed paste so a multi-line prompt lands in the editor whole rather than being executed
 * line by line. The caller ensures the session exists first.
 *
 * Deliberately does not press Enter: IWE cannot tell a running agent from a shell (pi's status
 * is the agent extension's private vocabulary), and submitting a paragraph to a shell would run
 * it. The user reads it and sends it, which is the one keystroke worth keeping.
 *
 * The buffer is named for the change, so two prompts sent close together cannot overwrite each
 * other's text between the load and the paste.
 */
export const pastePrompt = (id: string, text: string): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const buffer = `iwe-prompt-${id}`;
    // `--` so a prompt that begins with a dash is data, not an option.
    yield* shOrThrow(tmuxCmd(["set-buffer", "-b", buffer, "--", text]));
    yield* shOrThrow(tmuxCmd(["paste-buffer", "-p", "-b", buffer, "-t", sessionName(id)]));
    yield* shOrThrow(tmuxCmd(["delete-buffer", "-b", buffer]));
  });

/**
 * Put a window where another one is, shifting the windows in between. tmux's own move-window
 * refuses an occupied index, so this is a walk of swaps along the session's actual indices —
 * which may have gaps where a window was closed. The current window follows the move, wherever
 * it is in the shuffle.
 */
export const moveWindow = (id: string, from: number, to: number): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (from === to) return;
    const listed = yield* shOrThrow(
      tmuxCmd(["list-windows", "-t", sessionName(id), "-F", "#{window_index}"]),
    );
    const indexes = listed.split("\n").filter(Boolean).map(Number);
    const start = indexes.indexOf(from);
    const end = indexes.indexOf(to);
    if (start === -1 || end === -1) return; // a window that has gone since the drag began
    const step = start < end ? 1 : -1;
    for (let i = start; i !== end; i += step) {
      yield* shOrThrow(
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
