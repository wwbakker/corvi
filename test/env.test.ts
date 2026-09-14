import { expect, test } from "bun:test";
import { childEnv } from "../src/capabilities/env.ts";

/**
 * The environment children get: the server's own, scrubbed of the launcher's variables, with the
 * caller's additions applied after the scrub (src/capabilities/env.ts tells the whole story).
 */
test("the launcher's variables do not reach a child", () => {
  const env = childEnv({
    PATH: "/bin",
    HOME: "/home/you",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    IWE_PORT: "4000",
    IWE_ROOT: "/changes",
    IWE_TEST_RUN: "abc",
    TMUX: "/tmp/tmux-501/default,1,0",
    TMUX_PANE: "%0",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/home/you");
  // Kept: how a tool inside a pane addresses its own tmux server.
  expect(env.TMUX).toBe("/tmp/tmux-501/default,1,0");
  expect(env.TMUX_PANE).toBe("%0");
  // Scrubbed: the launcher's, and everything of IWE's own by prefix.
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(env.NODE_ENV).toBeUndefined();
  expect(env.IWE_PORT).toBeUndefined();
  expect(env.IWE_ROOT).toBeUndefined();
  expect(env.IWE_TEST_RUN).toBeUndefined();
});

test("the caller's additions are applied after the scrub, so a workspace can set these on purpose", () => {
  const env = childEnv({ PATH: "/bin", NODE_ENV: "production" }, {
    NODE_ENV: "development",
    IWE_CHANGE_ID: "PROJ-1",
  });
  expect(env.NODE_ENV).toBe("development");
  expect(env.IWE_CHANGE_ID).toBe("PROJ-1");
  expect(env.PATH).toBe("/bin");
});

test("undefined values are dropped rather than passed as the string 'undefined'", () => {
  expect(childEnv({ PATH: undefined, HOME: "/h" })).toEqual({ HOME: "/h" });
});
