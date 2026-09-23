/**
 * The app's binding of the terminal package's tmux operations: the process layer (`sh`) and the
 * product's own names (`ID`, `env`) are supplied here, so `@corvi/terminals` never reads the
 * environment and the tmux half stays a set of CLI calls with no app imports.
 *
 * The socket is read per command through a getter, because a test run or a sandbox copy may
 * change `CORVI_TMUX_SOCKET` after this module is first imported.
 */
import { Effect } from "effect";

import {
  make,
  type CommandFailure,
  type CommandResult,
  type Host,
  type Sessions,
} from "@corvi/terminals/tmux";
import { CliError } from "@corvi/contracts/errors";
import { ID, env } from "@corvi/configuration/node";
import { sh, shOrThrow } from "../../capabilities/shell.ts";

/** The package names only the failure fields it reads; the app's CLI failure carries them all,
 * so a failed tmux call reaches the route mapper unchanged. */
const failure = (e: CliError): CommandFailure => ({
  message: e.message,
  stderr: e.stderr,
  exitCode: e.exitCode,
});

const host: Host = {
  run: (args) => sh(args).pipe(Effect.catchAll((e) => Effect.fail(failure(e)))),
  runOrThrow: (args) =>
    shOrThrow(args).pipe(
      Effect.map((stdout): CommandResult => ({ code: 0, stdout, stderr: "" })),
      Effect.catchAll((e) => Effect.fail(failure(e))),
    ),
  get socket(): string {
    return process.env[env("TMUX_SOCKET")] || ID;
  },
  name: ID,
  env,
};

export const sessions: Sessions = make(host);

export const {
  sessionName,
  terminalSocketPath,
  attachCommand,
  stopTerminal,
  changeOfSession,
  newWindow,
  newWindowRunning,
  selectWindow,
  moveWindow,
  ensureSession,
  pastePromptTo,
  submit,
  windows: rawWindows,
  allWindows: rawAllWindows,
} = sessions;
