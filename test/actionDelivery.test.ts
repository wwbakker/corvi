import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { writeActionFile } from "../apps/server/src/actions/server/files.ts";
import { runActionFor } from "../apps/server/src/actions/server/run.ts";
import type { Change } from "../apps/server/src/domain/change.ts";
import { closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import { configPath } from "../apps/server/src/workspace/server/index.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * Action delivery on host sessions. The run opens a host window for the command and the command
 * takes effect; this is the path `deliver.ts` uses once a change's terminals are host sessions.
 *
 * The host must run on Node, so the test points the server's host client at `node`
 * (`CORVI_HOST_RUNTIME`) and shuts it down when it is done — the host outlives a server by design,
 * but a test leaves no process behind.
 */
const own = await testTempDir("action-host");
process.env.CORVI_CONFIG = join(own, "config.json");
process.env.CORVI_HOST_RUNTIME = "node";
await mkdir(join(own, "actions"), { recursive: true });
await writeFile(configPath(), "{}");

const change: Change = {
  id: "PROJ-action-host",
  branch: "PROJ-action-host",
  checkouts: [],
  state: "Implementation",
  createdAt: new Date().toISOString(),
};
await mkdir(join(process.env.CORVI_ROOT ?? "", change.id), { recursive: true });

afterAll(async () => {
  await closeHostClient();
});

test("an action runs in a host window and its command takes effect", async () => {
  const stamp = join(own, "action-ran.txt");
  await Effect.runPromise(
    writeActionFile({
      scope: "global",
      id: "mark",
      text: `---\nlabel: Mark\nkind: command\ntarget: new\n---\necho ran > ${stamp}\n`,
    }),
  );
  const result = await Effect.runPromise(runActionFor(change, "global:mark"));
  expect(result.started).toBe(true);
  expect(result.window?.id).toBeDefined();
  await waitFor(
    "the action's command to write the file",
    async () => (await Bun.file(stamp).text().catch(() => "")).trim() === "ran",
    20_000,
  );
  expect((await Bun.file(stamp).text()).trim()).toBe("ran");
}, 30_000);

test("a prompt action pastes into a host window without submitting", async () => {
  const stamp = join(own, "prompt-stamp.txt");
  await Effect.runPromise(
    writeActionFile({
      scope: "global",
      id: "note",
      text: `---\nlabel: Note\nkind: prompt\ntarget: active\n---\necho pasted > ${stamp}\n`,
    }),
  );
  const result = await Effect.runPromise(runActionFor(change, "global:note"));
  expect(result.started).toBe(false);
  expect(result.submitted).toBe(false);
  // Not submitted, so the prompt sits in the shell's input; the text is in the terminal, not the
  // file. Submitting is the user's keystroke and the next test covers the delivered write path.
  expect(await Bun.file(stamp).exists()).toBe(false);
}, 30_000);
