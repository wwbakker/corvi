/** Per-harness knowledge: how to start a subagent's session and which id to pin it to.
 *
 * Small and pure, so the one place that differs per harness is data. `pi` pins the session with
 * `--session-id` (exact project session id, created if missing) and takes `--model` /
 * `--thinking`; `opencode` uses `--session` and `--model`, and has no thinking-level flag, so
 * `effort` is ignored there. The window's working directory is the subagent's directory, which is
 * what keys a harness's own session storage. */
import type { SubagentHarness } from "@corvi/contracts/subagents";
import type { Profile } from "./profile.ts";

export type HarnessLaunch = {
  readonly command: string;
  readonly args: readonly string[];
};

export type HarnessInput = {
  readonly harness: SubagentHarness;
  readonly sessionId: string;
  readonly label: string;
  readonly model?: string;
  readonly effort?: string;
};

/** The command and arguments that start (or resume) a subagent session. */
export const launchOf = (input: HarnessInput): HarnessLaunch => {
  if (input.harness === "pi") {
    return {
      command: "pi",
      args: [
        "--session-id",
        input.sessionId,
        "--name",
        input.label,
        ...(input.model === undefined ? [] : ["--model", input.model]),
        ...(input.effort === undefined ? [] : ["--thinking", input.effort]),
      ],
    };
  }
  return {
    command: "opencode",
    args: [
      "--session",
      input.sessionId,
      ...(input.model === undefined ? [] : ["--model", input.model]),
      // opencode has no thinking-level flag; `effort` is not passed.
    ],
  };
};

/** The launch for a profile. `sessionId` is the subagent id: pinned, so reopening resumes the
 * same harness session. */
export const launchFor = (
  profile: Pick<Profile, "harness" | "model" | "effort">,
  sessionId: string,
  label: string,
): HarnessLaunch => launchOf({ harness: profile.harness, sessionId, label, model: profile.model, effort: profile.effort });

/** POSIX single-quote wrapping: whatever a model id or label contains, it is data to the shell
 * tmux runs the command with. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The launch as one shell command line, for `tmux new-window`. */
export const launchCommand = (launch: HarnessLaunch): string =>
  [launch.command, ...launch.args].map(shellQuote).join(" ");
