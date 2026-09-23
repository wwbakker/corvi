import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { soft } from "@corvi/shell/cli";
import { CliError } from "@corvi/contracts/errors";
import { currentBranch } from "../apps/server/src/vendors/git.ts";
import { sh } from "../apps/server/src/capabilities/shell.ts";
import { Workspace as WorkspaceTag } from "@corvi/contracts/workspace";
import { workspaceById } from "../apps/server/src/workspace/server/index.ts";
import { fakeShell, runWithShell } from "./helpers.ts";
import type { Workspace } from "@corvi/configuration/config";

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
 * Routes provide only the `Workspace` tag, no `Shell` (apps/server/src/capabilities/web.ts), so the direct
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

/** The environment a CLI spawn gets: the scrubbed server env, with the workspace's own variables
 * on top (apps/server/src/capabilities/env.ts). The test plants the launcher's variables in its own
 * environment, since the server they leak from is this suite's parent when it runs inside a pane
 * — which is exactly the leak the scrub exists for. */
test("a CLI spawn inherits neither the launcher's variables nor passes them to the workspace's", async () => {
  const previous = { port: process.env.CORVI_PORT, electron: process.env.ELECTRON_RUN_AS_NODE };
  process.env.CORVI_PORT = "4000";
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const workspace: Workspace = { id: "env-test", name: "Env test", env: { MY_OWN: "yes" } };
    const result = await Effect.runPromise(
      Effect.provide(
        sh(["sh", "-c", "echo $CORVI_PORT:$ELECTRON_RUN_AS_NODE:$MY_OWN"]),
        Layer.succeed(WorkspaceTag, workspace),
      ),
    );
    expect(result).toMatchObject({ code: 0, stdout: "::yes" });
  } finally {
    if (previous.port === undefined) delete process.env.CORVI_PORT;
    else process.env.CORVI_PORT = previous.port;
    if (previous.electron === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous.electron;
  }
});

test("soft: a CliError with an empty stderr still reports its message", async () => {
  // The Result-branching contract keeps the sentence: "no Shell in context" and a timeout name
  // themselves in `message`, not `stderr`, and dropping it here hands the page an empty line —
  // which the transport boundary then renders as the error's type name.
  const result = await Effect.runPromise(
    soft(
      Effect.fail(
        new CliError({
          tool: "gh",
          command: "gh pr list",
          stderr: "",
          exitCode: 127,
          message: "gh pr list failed: no Shell in context",
        }),
      ),
    ),
  );
  expect(result).toEqual({
    code: 127,
    stdout: "",
    stderr: "gh pr list failed: no Shell in context",
  });
});
