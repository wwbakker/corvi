/** Per-harness knowledge: how to start a subagent's session and which id to pin it to.
 *
 * Small and pure, so the one place that differs per harness is data. `pi` pins the session with
 * `--session-id` (exact project session id, created if missing) and takes `--model` /
 * `--thinking`; `opencode` uses `--session` and `--model`, and has no thinking-level flag, so
 * `effort` is ignored there. The window's working directory is the subagent's directory, which is
 * what keys a harness's own session storage. */
import type { SubagentHarness } from "@corvi/contracts/subagents";

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
