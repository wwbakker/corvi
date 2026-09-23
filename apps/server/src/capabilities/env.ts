/**
 * The environment every child Corvi starts receives: the server's own, scrubbed of the variables
 * the launcher gave the server, with the caller's additions applied after the scrub.
 *
 * The server runs on Electron's own Node, started by the app as
 * `env CORVI_PORT=… NODE_ENV=production ELECTRON_RUN_AS_NODE=1 …`
 * (apps/desktop/src/electron/main.ts), so the server's `process.env` carries the launcher's variables.
 * Children must not inherit them: with `ELECTRON_RUN_AS_NODE=1` any Electron binary started in a
 * terminal — `code .`, `electron .`, a VS Code task — silently runs as plain Node;
 * `NODE_ENV=production` changes other tools' behaviour; and `CORVI_PORT`/`CORVI_ROOT` point a server
 * started by hand at the app's port and data root. Everything else — the login environment the
 * app's server was given, `PATH`, `HOME`, the SSH agent — passes through untouched.
 *
 * `TMUX` and `TMUX_PANE` are deliberately kept: they are how a tool inside a pane addresses its
 * own server, and the product relies on that — the agent reporters the manual documents
 * (`integrations/pi`, `integrations/opencode`), and any prompt that asks tmux where it is.
 *
 * The caller's additions are applied *after* the scrub, so a workspace can set any of these
 * variables on purpose (`shell.ts` applies the workspace's configured `env` this way), and the
 * terminal adds the change's context (`CORVI_CHANGE_ID`, `CORVI_CHANGE_DIR`) rather than leaving it
 * to accident.
 */
import { ENV_PREFIX } from "@corvi/configuration/node";

export const childEnv = (
  base: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> => {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE" || key === "NODE_ENV" || key.startsWith(ENV_PREFIX)) continue;
    child[key] = value;
  }
  return { ...child, ...extra };
};
