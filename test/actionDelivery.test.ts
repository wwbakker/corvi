import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { writeActionFile } from "../apps/server/src/actions/server/files.ts";
import { runActionFor } from "../apps/server/src/actions/server/run.ts";
import type { Change } from "../apps/server/src/domain/change.ts";
import { closeHostClient, hostClient } from "../apps/server/src/terminals/server/host.ts";
import * as registry from "../apps/server/src/terminals/server/registry.ts";
import { setStatus } from "../apps/server/src/terminals/server/status.ts";
import { listWindowsAsync, newWindowAsync } from "../apps/server/src/terminals/server/windows.ts";
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
// The env this file mutates, saved so a co-located test file does not inherit it (bun runs the
// files of a run in one process).
const savedEnv = {
  CORVI_HOST_RUNTIME: process.env.CORVI_HOST_RUNTIME,
  CORVI_TMUX_SOCKET: process.env.CORVI_TMUX_SOCKET,
  TMUX: process.env.TMUX,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
};
const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.CORVI_HOST_RUNTIME = "node";
// Every window is a host session now; the tmux socket is a leftover from the transitional
// aggregation and is harmless, but the tests no longer read it.
delete process.env.TMUX;
process.env.CORVI_TMUX_SOCKET = join(own, "tmux.sock");
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
  await rm(own, { recursive: true, force: true });
  restoreEnv();
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

test("a kept command window freezes with its label and fires the notify edge", async () => {
  const stamp = join(own, "frozen-output.txt");
  await Effect.runPromise(
    writeActionFile({
      scope: "global",
      id: "freeze",
      text: `---\nlabel: Freeze me\nkind: command\ntarget: new\nnotify: true\nkeepOpen: true\n---\necho FROZEN-OUTPUT > ${stamp}\n`,
    }),
  );
  const result = await Effect.runPromise(runActionFor(change, "global:freeze"));
  expect(result.started).toBe(true);
  const id = result.window?.id;
  expect(id).toBeDefined();
  // The record carries the announced label, not the raw command text.
  const record = registry.records(change.id).find((entry) => entry.id === id);
  expect(record?.label).toBe("Freeze me");
  expect(record?.keepOpen).toBe(true);
  expect(record?.notify).toBe(true);

  await waitFor("the command to run", async () => (await Bun.file(stamp).text().catch(() => "")) === "FROZEN-OUTPUT\n", 20_000);
  await waitFor("the retained window to present as finished", async () => {
    const frozen = (await listWindowsAsync(change.id)).find((window) => window.id === id);
    return frozen?.attention === true && frozen?.label === "Freeze me" && frozen?.busy === false;
  }, 20_000);
  const frozen = (await listWindowsAsync(change.id)).find((window) => window.id === id);
  expect(frozen?.label).toBe("Freeze me");
  expect(frozen?.note).toContain("exit code 0");
}, 40_000);

test("an agent-target action uses a running host agent window instead of a fresh pi", async () => {
  const session = await newWindowAsync(change.id, join(process.env.CORVI_ROOT ?? own, change.id));
  const hostSession = (await (await hostClient()).list()).find((entry) => entry.id === session.id);
  expect(hostSession).toBeDefined();
  setStatus(session.id, hostSession!.incarnation, { state: "working", name: "pi", at: new Date().toISOString() });

  const stamp = join(own, "agent-note.txt");
  await Effect.runPromise(
    writeActionFile({
      scope: "global",
      id: "agent-note",
      text: `---\nlabel: Agent note\nkind: prompt\ntarget: agent\n---\necho agent-note > ${stamp}\n`,
    }),
  );
  const result = await Effect.runPromise(runActionFor(change, "global:agent-note"));
  // Delivered into the running agent window, not a new pi.
  expect(result.started).toBe(false);
  expect(result.window?.id).toBe(session.id);
}, 40_000);
