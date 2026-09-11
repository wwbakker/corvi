import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { currentBranch } from "../src/core/integrations/git.ts";
import { sh } from "../src/core/platform/capabilities/sh.ts";
import { Workspace as WorkspaceTag } from "../src/core/platform/effect/tags.ts";
import { workspaceById } from "../src/workspace/server/index.ts";
import { fakeShell, runWithShell } from "./helpers.ts";

/**
 * The fake-Shell seam: core integration code calls the module-level `sh`, which prefers a
 * `Shell` service in context. Providing a scripted one drives a real integration function
 * with no subprocess, and the recorded calls prove the read went through the seam.
 */
describe("sh with a provided Shell", () => {
  test("a core git read runs through the fake Shell and parses its output", async () => {
    const shell = fakeShell({ "git rev-parse --abbrev-ref HEAD": "feature/shell-seam" });

    const branch = await runWithShell(shell, currentBranch("/repos/demo"));

    expect(branch).toBe("feature/shell-seam");
    expect(shell.calls).toEqual([
      { cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd: "/repos/demo" },
    ]);
  });
});

/**
 * Routes provide only the `Workspace` tag, no `Shell` (src/core/platform/routes/helpers.ts), so the direct
 * path is production code: with no Shell in context `sh` must still spawn exactly as before.
 */
test("with no Shell in context, sh spawns directly", async () => {
  const result = await Effect.runPromise(
    Effect.provide(
      sh(["sh", "-c", "echo direct"]),
      Layer.succeed(WorkspaceTag, workspaceById(undefined)),
    ),
  );
  expect(result).toMatchObject({ code: 0, stdout: "direct" });
});
