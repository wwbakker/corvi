/**
 * The host-backed `ActionSessions`: a new action run opens a host session, a paste is a bracketed
 * write, and a submit is an Enter.
 *
 * Every window is a host session now — interactive shells, action runs and subagents — so a
 * target is always a session id (the `w-…` the registry holds).
 */
import { Effect } from "effect";
import type { ActionSessions } from "@corvi/actions/deliver";
import type { CommandFailure } from "@corvi/terminals/model";
import { newWindowRunningAsync, writeToHostWindow } from "./windows.ts";

const asFailure = (error: unknown): CommandFailure => ({
  message: error instanceof Error ? error.message : String(error),
  stderr: "",
  exitCode: 1,
});

const hostWrite = (window: string, data: string): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({
    try: async () => {
      // A dead or unknown window is a failed delivery: the caller must not report success on a
      // paste that never landed.
      if (!(await writeToHostWindow(window, data))) throw new Error(`no live terminal for window ${window}`);
    },
    catch: asFailure,
  });

export const actionSessions: ActionSessions = {
  newWindowRunning: (changeId, dir, command, options) =>
    Effect.tryPromise({ try: () => newWindowRunningAsync(changeId, dir, command, options), catch: asFailure }),
  pastePromptTo: (window, text) => hostWrite(window, `\x1b[200~${text}\x1b[201~`),
  submit: (window) => hostWrite(window, "\r"),
};
