import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { configPath } from "../apps/server/src/workspace/server/index.ts";
import { root } from "../apps/server/src/change/server/store.ts";
import { isRunToken } from "../scripts/clean-test.ts";

/**
 * The tripwire under the isolation itself.
 *
 * `scripts/test-isolation.ts` (wired in `bunfig.toml`) points the product's path resolution at a
 * per-run temp root whenever the wrapper has not already. This asserts the wiring held in the
 * process this file runs in — every worker, every way of running the suite — because the failure
 * mode is a test writing someone's real config, and that is worth a loud line of its own. The
 * paths are exactly the ones whose "else" case is a directory in someone's home.
 */
test("the suite runs against its own tree, never the user's", () => {
  expect(resolve(configPath())).not.toBe(resolve(join(homedir(), ".config", "corvi", "config.json")));
  expect(resolve(root())).not.toBe(resolve(join(homedir(), "corvi", "changes")));
  // And the run is attributable: its token is the shape scripts/clean-test.ts reads, so a
  // crashed run's resources can be swept without touching a live one's.
  expect(isRunToken(process.env.CORVI_TEST_RUN ?? "")).toBe(true);
});
