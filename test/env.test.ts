import { expect, test } from "bun:test";
import { childEnv, cliAwarePath } from "../apps/server/src/capabilities/env.ts";

/**
 * The environment children get: the server's own, scrubbed of the launcher's variables, with the
 * caller's additions applied after the scrub (apps/server/src/capabilities/env.ts tells the whole story).
 */
test("the launcher's variables do not reach a child", () => {
  const env = childEnv({
    PATH: "/bin",
    HOME: "/home/you",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    CORVI_PORT: "4000",
    CORVI_ROOT: "/changes",
    CORVI_TEST_RUN: "abc",
    TMUX: "/tmp/tmux-501/default,1,0",
    TMUX_PANE: "%0",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/home/you");
  // Passed through here; the terminal's own builder drops them for a host session.
  expect(env.TMUX).toBe("/tmp/tmux-501/default,1,0");
  expect(env.TMUX_PANE).toBe("%0");
  // Scrubbed: the launcher's, and everything of Corvi's own by prefix.
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(env.NODE_ENV).toBeUndefined();
  expect(env.CORVI_PORT).toBeUndefined();
  expect(env.CORVI_ROOT).toBeUndefined();
  expect(env.CORVI_TEST_RUN).toBeUndefined();
});

test("the caller's additions are applied after the scrub, so a workspace can set these on purpose", () => {
  const env = childEnv({ PATH: "/bin", NODE_ENV: "production" }, {
    NODE_ENV: "development",
    CORVI_CHANGE_ID: "PROJ-1",
  });
  expect(env.NODE_ENV).toBe("development");
  expect(env.CORVI_CHANGE_ID).toBe("PROJ-1");
  expect(env.PATH).toBe("/bin");
});

test("undefined values are dropped rather than passed as the string 'undefined'", () => {
  expect(childEnv({ PATH: undefined, HOME: "/h" })).toEqual({ HOME: "/h" });
});

test("the CLI shim is put in front of PATH only when no corvi already resolves", () => {
  // A launcher-installed corvi keeps winning: the shim never shadows it.
  expect(cliAwarePath({ root: "/repo", path: "/usr/bin", corviAvailable: true })).toBeUndefined();
  expect(cliAwarePath({ root: "/repo", path: "/usr/bin", corviAvailable: false })).toBe("/repo/apps/cli/bin:/usr/bin");
  // No PATH at all is the shim alone, with no trailing separator.
  expect(cliAwarePath({ root: "/repo", path: undefined, corviAvailable: false })).toBe("/repo/apps/cli/bin");
});
