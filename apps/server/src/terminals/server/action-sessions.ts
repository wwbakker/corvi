/**
 * The host-backed `ActionSessions`: a new action run opens a host session, a paste is a bracketed
 * write, and a submit is an Enter.
 *
 * Agent windows are still tmux windows (subagents keep their own substrate until their slice), so
 * a target whose id is a tmux window id (`@3`) is delivered through the tmux binding; everything
 * else is a host session.
 */
import { Effect } from "effect";
import type { ActionSessions } from "@corvi/actions/deliver";
import type { CommandFailure } from "@corvi/terminals/tmux";
import { sessions as tmuxSessions } from "./tmux.ts";
import { newWindowRunningAsync, writeToHostWindow } from "./windows.ts";

const asFailure = (error: unknown): CommandFailure => ({
  message: error instanceof Error ? error.message : String(error),
  stderr: "",
  exitCode: 1,
});

/** tmux window ids look like `@3`; host session ids never start with `@`. */
const isTmuxWindow = (window: string): boolean => window.startsWith("@");

const hostWrite = (window: string, data: string): Effect.Effect<void, CommandFailure> =>
  Effect.tryPromise({
    try: async () => {
      await writeToHostWindow(window, data);
    },
    catch: asFailure,
  });

export const actionSessions: ActionSessions = {
  newWindowRunning: (changeId, dir, command, options) =>
    Effect.tryPromise({ try: () => newWindowRunningAsync(changeId, dir, command, options), catch: asFailure }),
  pastePromptTo: (window, text) =>
    isTmuxWindow(window) ? tmuxSessions.pastePromptTo(window, text) : hostWrite(window, `\x1b[200~${text}\x1b[201~`),
  submit: (window) => (isTmuxWindow(window) ? tmuxSessions.submit(window) : hostWrite(window, "\r")),
};
