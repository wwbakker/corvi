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
import { join } from "node:path";
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

/** The CLI's shim directory (`apps/cli/bin/corvi`) in front of a PATH — or nothing to do, when
 * a `corvi` already resolves. The shadowing rule is deliberate: where a launcher installed one
 * (Linux, `bun run app:install`), it keeps winning, `start`/`stop` and all, and the shim never
 * shadows it. Pure, so the rule is a unit test's own (`test/tmuxSessionEnv.test.ts`). */
export const cliAwarePath = (input: {
  readonly root: string;
  readonly path: string | undefined;
  readonly corviAvailable: boolean;
}): string | undefined =>
  input.corviAvailable
    ? undefined
    : `${join(input.root, "apps", "cli", "bin")}${input.path === undefined ? "" : `:${input.path}`}`;

/** Put the CLI on this process's PATH — once at startup (apps/server/src/server.ts). tmux builds
 * each pane's environment from the **creating client's** and pins `PATH`/`SHELL` to it: session-
 * and server-level environments cannot set `PATH` at all (`new-session -e`, `new-window -e` and
 * `set-environment` are all ignored for it), and every client Corvi spawns — the tmux commands
 * through `sh()`, the attach ptys through `childEnv` above — inherits this process's
 * environment. A pane's own shell then keeps what its rc files prepend or append, but may still
 * replace PATH outright; that residual is documented in docs/manual/install.md. Whether a
 * `corvi` already resolves is the caller's question (`commandAvailable` lives in `./os.ts`, and
 * importing it here would close a cycle back through `shell.ts`), so this module keeps its one
 * dependency. */
export const putCliOnPath = (root: string, corviAvailable: boolean): void => {
  const path = cliAwarePath({ root, path: process.env.PATH, corviAvailable });
  if (path !== undefined) process.env.PATH = path;
};
