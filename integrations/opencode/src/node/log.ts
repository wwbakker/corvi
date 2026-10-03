/**
 * Where this extension's own errors go.
 *
 * A subagent runs in a pty, so anything written to stderr lands in its terminal — and Corvi
 * parses that terminal, persists it as the window's screen and shows it to the user. A failed
 * `corvi` command is Corvi's own problem, not part of the agent's conversation, so the extension
 * appends it to the app's log file (`CORVI_LOG`, seeded by the server per pane) instead. Outside
 * a Corvi session there is no file to write to (plain pi), and stderr is the honest answer.
 *
 * The append is synchronous: this runs on an error path, not a hot one, and a crash should not
 * lose the line that says why.
 */
import { appendFileSync } from "node:fs";

/** Who a shared-log line belongs to: the subagent's id, else the pane's session id. */
const source = (env: NodeJS.ProcessEnv): string => {
  const subagent = env.CORVI_SUBAGENT_ID?.trim();
  if (subagent !== undefined && subagent !== "") return subagent;
  const session = env.CORVI_SESSION_ID?.trim();
  return session !== undefined && session !== "" ? session : "corvi";
};

/** Append one extension log line, timestamped and sourced. With `CORVI_LOG` it goes to the app
 * log; without it, to stderr, prefixed so a plain-pi operator still sees whose line it is. */
export const logLine = (message: string, env: NodeJS.ProcessEnv = process.env): void => {
  const path = env.CORVI_LOG;
  if (path === undefined || path === "") {
    // No Corvi log to file into (plain pi/opencode outside a Corvi session): stderr is the only
    // place left, and it is not a Corvi pane.
    console.error(`[corvi] ${message}`);
    return;
  }
  try {
    appendFileSync(path, `[${new Date().toISOString()}] [${source(env)}] ${message}\n`);
  } catch {
    // With a log file there is nothing safe to fall back to: stderr is the pane this sink exists
    // to keep clean, so the line is dropped rather than drawn into the agent's screen.
  }
};
