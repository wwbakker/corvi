import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { closeHostClient, hostClient } from "../apps/server/src/terminals/server/host.ts";
import * as registry from "../apps/server/src/terminals/server/registry.ts";
import {
  closePaneAsync,
  ensureActiveHostWindow,
  focusPaneAsync,
  isKeptOpen,
  currentPaneDirectory,
  listWindowsAsync,
  moveWindowAsync,
  newWindowAsync,
  newWindowHereAsync,
  placeOf,
  newWindowRunningAsync,
  renameWindowAsync,
  writeToPane,
  selectWindowAsync,
  selectWindowByIdAsync,
  splitPaneAsync,
  stopHostTerminals,
} from "../apps/server/src/terminals/server/windows.ts";
import { stateDir } from "@corvi/configuration/node";
import { WINDOW_TITLE_MAX } from "@corvi/contracts/terminal";
import { TerminalSessions, terminalSessionsLayer } from "../apps/server/src/change/lifecycle-layer.ts";
import { budget, testTempDir, waitFor } from "./helpers.ts";

/**
 * The registry's I/O half, against real host windows: new windows persist in order with one
 * active, select and move mutate the persisted records, and a fresh read (a simulated restart)
 * sees the same. Since subagents moved to host sessions there is no second backing to merge.
 *
 * The state dir is this file's own (helpers.ts); no process outside it is touched.
 */
const dir = await testTempDir("registry");
// The env this file mutates, saved so a co-located test file does not inherit it (bun runs the
// files of a run in one process).
const savedEnv = {
  CORVI_HOST_RUNTIME: process.env.CORVI_HOST_RUNTIME,
};
const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.CORVI_HOST_RUNTIME = "node";
const changeId = "REG-IO";
const ids = (): string[] => registry.records(changeId).map((record) => record.id);

afterAll(async () => {
  await stopHostTerminals(changeId);
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
  restoreEnv();
});

test("a new window opens where the active shell is, not where it was opened", async () => {
  const here = "REG-HERE";
  const first = await newWindowAsync(here, dir);
  const client = await hostClient();
  // As a prompt does after a cd. The sleep keeps the terminal busy, so no prompt comes back to
  // announce the opening directory over the new one.
  await client.write(first.activePane, "printf '\\033]7;file://host/tmp\\007'; sleep 30\n");
  await waitFor(
    "the announced directory",
    async () =>
      (await client.list()).find((entry) => entry.id === first.activePane)?.workingDirectory === "/tmp",
  );
  const second = await newWindowHereAsync(here, dir);
  expect((await client.list()).find((entry) => entry.id === second.activePane)?.cwd).toBe("/tmp");
  // The change env is seeded from the change's own directory whatever directory the shell is in:
  // the CLI finds its change by it.
  const seen: string[] = [];
  client.onData(second.activePane, (data) => seen.push(data.toString()));
  await client.attach(second.activePane, 0);
  await client.write(second.activePane, `echo "ENV-DIR=$CORVI_CHANGE_DIR"\n`);
  await waitFor("the change env", async () => seen.join("").includes(`ENV-DIR=${dir}`));
  await stopHostTerminals(here);
}, 60_000);

test("where a session is, named relative to its change", () => {
  // The change's own root is its directory name; below it, the path relative to the change, which
  // is what a window needs (the change is already the row it sits under).
  expect(placeOf("/c/ID", "/c/ID")).toBe("ID");
  expect(placeOf("/c/ID", "/c/ID/corvi")).toBe("corvi");
  expect(placeOf("/c/ID", "/c/ID/corvi/packages/terminals")).toBe("corvi/packages/terminals");
  // Outside the change, or the same place reached by another path: the last segment, never a path
  // that says nothing.
  expect(placeOf("/c/ID", "/Users/me/corvi")).toBe("corvi");
  expect(placeOf("/private/tmp/c/ID", "/tmp/c/ID/corvi")).toBe("corvi");
  expect(placeOf("/c/ID", undefined)).toBeUndefined();
  expect(placeOf("/c/ID", "")).toBeUndefined();
});

test("new windows persist in order with one active; select and move mutate them", async () => {
  const first = await newWindowAsync(changeId, dir);
  const second = await newWindowAsync(changeId, dir);
  let records = registry.records(changeId);
  expect(records.map((record) => record.id)).toEqual([first.id, second.id]);
  expect(records.filter((record) => record.active)).toHaveLength(1);
  expect(records.find((record) => record.active)?.id).toBe(second.id);

  await selectWindowAsync(changeId, 0);
  records = registry.records(changeId);
  expect(records[0]?.active).toBe(true);
  expect(records[1]?.active).toBe(false);

  await moveWindowAsync(changeId, 0, 1);
  expect(ids()).toEqual([second.id, first.id]);

  // A fresh read sees the same list: what a restart's rebuild starts from.
  expect(registry.read().changes[changeId]?.map((record) => record.id)).toEqual([second.id, first.id]);
}, 30_000);

test("a window can be named from its record: trimmed, persisted, cleared, and only while it exists", async () => {
  const namedChange = "REG-RENAME";
  const window = await newWindowAsync(namedChange, dir);
  const stored = (): registry.WindowRecord | undefined =>
    registry.records(namedChange).find((record) => record.id === window.id);

  await renameWindowAsync(namedChange, window.id, "  build logs  ");
  expect(stored()).toBeDefined();
  expect(stored()?.title).toBe("build logs");
  // A fresh read (what a restart's rebuild starts from) and the presented list both keep it: the
  // name belongs to the window, so the shell need not know it.
  const windows = await listWindowsAsync(namedChange);
  expect(windows.find((entry) => entry.id === window.id)).toMatchObject({
    label: "build logs",
    title: "build logs",
  });
  expect(stored()?.title).toBe("build logs");

  // Blank means "use the default again": the record carries no title and the file keeps no key.
  await renameWindowAsync(namedChange, window.id, "   ");
  expect(stored()).toBeDefined();
  expect(stored()?.title).toBeUndefined();
  const file = JSON.parse(await Bun.file(join(stateDir(), "terminal-windows.json")).text()) as {
    readonly changes: Record<string, { readonly id: string; readonly title?: string }[]>;
  };
  expect(file.changes[namedChange]?.find((entry) => entry.id === window.id)).not.toHaveProperty("title");
  expect(
    (await listWindowsAsync(namedChange)).find((entry) => entry.id === window.id)?.title,
  ).toBeUndefined();

  // The writer caps as the reader does: a caller that skips the route cannot store a name the
  // next read would silently shrink.
  await renameWindowAsync(namedChange, window.id, "y".repeat(WINDOW_TITLE_MAX + 10));
  expect(stored()?.title).toBe("y".repeat(WINDOW_TITLE_MAX));

  // A window that is not there is an error, exactly as selecting one by id is.
  await expect(renameWindowAsync(namedChange, "w-missing", "x")).rejects.toThrow(/no window w-missing/);
  await stopHostTerminals(namedChange);
}, 60_000);

test("naming an action window leaves its action label alone", async () => {
  // `label` is what makes a window an action run (`@corvi_action`); a name is a separate fact, so
  // renaming one must not stop it being presented as a command window.
  const namedChange = "REG-RENAME-ACTION";
  const action = await newWindowRunningAsync(namedChange, dir, "sleep 30", {
    announce: { label: "Build", notify: false },
  });
  await renameWindowAsync(namedChange, action, "Release build");
  const record = registry.records(namedChange).find((entry) => entry.id === action)!;
  expect(record.label).toBe("Build");
  expect(record.title).toBe("Release build");
  expect((await listWindowsAsync(namedChange)).find((entry) => entry.id === action)?.label).toBe(
    "Release build",
  );
  await stopHostTerminals(namedChange);
}, 60_000);

test("a harness window opened for the user is the active tab, not a background one", async () => {
  const changeId = "REG-HARNESS-ACTIVE";
  const id = await newWindowRunningAsync(changeId, dir, "sleep 30", {
    intent: "activate",
    harness: "global:review",
    announce: { label: "Review environment", notify: false },
  });
  const windows = await listWindowsAsync(changeId);
  expect(windows.find((window) => window.id === id)?.active).toBe(true);
  expect(windows.find((window) => window.id === id)?.harness).toBe("global:review");
  await stopHostTerminals(changeId);
}, 60_000);

test("the first, split and action panes all carry their harness key", async () => {
  const change = "REG-HARNESS";
  const pane = async (): Promise<{ harness: string }> => ({ harness: "global:review" });
  await ensureActiveHostWindow(change, dir, { cols: 80, rows: 24 }, undefined, pane);
  let windows = await listWindowsAsync(change);
  expect(windows[0]?.harness).toBe("global:review");

  await splitPaneAsync(change, windows[0]!.id, "down", pane);
  windows = await listWindowsAsync(change);
  expect(windows[0]?.harness).toBe("global:review");

  const action = await newWindowRunningAsync(change, dir, "sleep 30", {
    harness: "global:action",
  });
  windows = await listWindowsAsync(change);
  expect(windows.find((entry) => entry.id === action)?.harness).toBe("global:action");
  await stopHostTerminals(change);
}, 60_000);

test("a shell in a checkout keeps the change root as its context", async () => {
  const changeId = "REG-CHECKOUT";
  const checkout = join(dir, "checkout-dir");
  const out = join(dir, "change-dir.txt");
  await mkdir(checkout, { recursive: true });
  const window = await newWindowAsync(changeId, checkout, { cols: 80, rows: 24 }, undefined, dir);
  const client = await hostClient();
  await client.write(window.activePane, `printf '%s' "$CORVI_CHANGE_DIR" > '${out}'\n`);
  await waitFor(
    "the env file",
    async () =>
      (await Bun.file(out)
        .text()
        .catch(() => "")) === dir,
  );
  await stopHostTerminals(changeId);
}, 60_000);

test("a command window in a checkout seeds its env from the change root", async () => {
  const changeId = "REG-COMMAND-CHECKOUT";
  const checkout = join(dir, "checkout-command");
  const out = join(dir, "command-change-dir.txt");
  await mkdir(checkout, { recursive: true });
  await newWindowRunningAsync(changeId, checkout, `printf '%s' "$CORVI_CHANGE_DIR" > '${out}'`, {
    cwd: checkout,
    envDir: dir,
    env: {},
  });
  await waitFor(
    "the command's env file",
    async () =>
      (await Bun.file(out)
        .text()
        .catch(() => "")) === dir,
  );
  await stopHostTerminals(changeId);
}, 60_000);

test("the current pane's directory is what the harness window's current choice resolves", async () => {
  const changeId = "REG-CURRENT";
  const checkout = join(dir, "checkout-current");
  await mkdir(checkout, { recursive: true });
  const window = await newWindowAsync(changeId, checkout, { cols: 80, rows: 24 }, undefined, dir);
  await waitFor("the pane cwd", async () => (await currentPaneDirectory(changeId, dir)) === checkout);
  expect(await currentPaneDirectory(changeId, dir)).toBe(checkout);
  await stopHostTerminals(changeId);
}, 60_000);

test("a pane warning is written as an inert comment, never run", async () => {
  const warningChange = "REG-WARNING";
  const marker = join(dir, "executed.txt");
  const window = await newWindowAsync(warningChange, dir);
  await writeToPane(window.activePane, `touch '${marker}'`);
  const client = await hostClient();
  // End the comment and let the shell report itself; the warning's text must never run.
  await client.write(window.activePane, "\n");
  await client.write(window.activePane, "echo ALIVE\n");
  await waitFor("the shell to answer", async () =>
    (await client.list()).some((entry) => entry.id === window.activePane),
  );
  await Bun.sleep(300);
  expect(await Bun.file(marker).exists()).toBe(false);
  await stopHostTerminals(warningChange);
}, 60_000);

test("a window's extra environment reaches the process it runs", async () => {
  const envChange = "REG-ENV";
  const out = join(dir, "env.txt");
  await newWindowRunningAsync(envChange, dir, `printf '%s' "$PI_CODING_AGENT_DIR" > '${out}'`, {
    env: { PI_CODING_AGENT_DIR: "/tmp/generated-harness" },
  });
  await waitFor(
    "the env file",
    async () =>
      (await Bun.file(out)
        .text()
        .catch(() => "")) === "/tmp/generated-harness",
  );
  await stopHostTerminals(envChange);
}, 60_000);

test("a background window does not take the active one; explicit creation does", async () => {
  const backgroundChange = "REG-INTENT";
  const explicit = await newWindowAsync(backgroundChange, dir);
  // An action run opens in the background: it must leave the current terminal selected.
  const background = await newWindowRunningAsync(backgroundChange, dir, "sleep 30", {});
  let records = registry.records(backgroundChange);
  expect(records.find((record) => record.id === explicit.id)?.active).toBe(true);
  expect(records.find((record) => record.id === background)?.active).toBe(false);

  // The strip's new-window control is explicit: its window becomes the active one.
  const chosen = await newWindowAsync(backgroundChange, dir);
  records = registry.records(backgroundChange);
  expect(records.find((record) => record.id === chosen.id)?.active).toBe(true);
  expect(records.find((record) => record.id === explicit.id)?.active).toBe(false);
  await stopHostTerminals(backgroundChange);
}, 60_000);

test("select-window-by-id selects exactly that window; a missing id is a failure", async () => {
  const byIdChange = "REG-BY-ID";
  const first = await newWindowAsync(byIdChange, dir);
  const second = await newWindowAsync(byIdChange, dir);
  expect(registry.records(byIdChange).find((record) => record.active)?.id).toBe(second.id);

  // The stable id picks the first window even though the second is active and later in order.
  await selectWindowByIdAsync(byIdChange, first.id);
  expect(registry.records(byIdChange).find((record) => record.active)?.id).toBe(first.id);

  // A window that is not there is an error, never a fallback to whatever is at index 0.
  await expect(selectWindowByIdAsync(byIdChange, "w-missing")).rejects.toThrow(/no window w-missing/);
  expect(registry.records(byIdChange).find((record) => record.active)?.id).toBe(first.id);
  await stopHostTerminals(byIdChange);
}, 60_000);

test("a background window is still a usable default when none was active", async () => {
  const backgroundChange = "REG-BG-FIRST";
  const background = await newWindowRunningAsync(backgroundChange, dir, "sleep 30", {});
  const records = registry.records(backgroundChange);
  expect(records.map((record) => record.id)).toEqual([background]);
  expect(records.filter((record) => record.active)).toHaveLength(1);
  expect(records[0]?.active).toBe(true);
  await stopHostTerminals(backgroundChange);
}, 60_000);

test("a read rebuilds from the live host sessions and keeps the persisted order", async () => {
  const before = ids();
  await listWindowsAsync(changeId);
  expect(ids()).toEqual(before);
}, 30_000);

test("a window holds panes: split adds and focuses one, focus-pane moves, close-pane removes", async () => {
  const window = await newWindowAsync(changeId, dir);
  let record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toEqual([window.id]);
  expect(record.activePane).toBe(window.id);

  await splitPaneAsync(changeId, window.id, "right");
  record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toHaveLength(2);
  const pane = record.panes.find((entry) => entry !== window.id)!;
  // The window id is stable; the new pane is the focused one.
  expect(record.id).toBe(window.id);
  expect(record.activePane).toBe(pane);

  await focusPaneAsync(changeId, window.id, window.id);
  expect(registry.records(changeId).find((entry) => entry.id === window.id)?.activePane).toBe(window.id);

  // Closing the split pane leaves the window with its first pane.
  await closePaneAsync(changeId, window.id, pane);
  record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toEqual([window.id]);

  // Closing the last pane drops the window.
  await closePaneAsync(changeId, window.id, window.id);
  expect(registry.records(changeId).some((entry) => entry.id === window.id)).toBe(false);
}, 60_000);

test(
  "closing the last pane does not resurrect the window while its pty lingers",
  async () => {
    // A command that ignores SIGHUP: `pty.kill()` cannot end it promptly, so its host session stays
    // alive after the close. It exits on its own after ~2 s.
    const ready = join(dir, "lingering-ready.txt");
    const id = await newWindowRunningAsync(
      changeId,
      dir,
      `trap '' HUP; echo ready > ${ready}; i=0; while [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done`,
      {},
    );
    // The trap must be installed before the signal, or the default SIGHUP ends the shell first.
    await waitFor("the shell to ignore SIGHUP", async () => await Bun.file(ready).exists(), budget(15_000));
    await closePaneAsync(changeId, id, id);
    expect(registry.records(changeId).some((entry) => entry.id === id)).toBe(false);
    // The tombstone is persisted with the registry, so a restart does not re-adopt the lingering pty.
    expect(registry.closedIds()).toContain(id);
    // The lingering session is alive; a rebuild must not re-adopt it and recreate the window.
    expect((await (await hostClient()).list()).some((entry) => entry.id === id && entry.alive)).toBe(true);
    const windows = await listWindowsAsync(changeId);
    expect(windows.some((window) => window.id === id)).toBe(false);
    expect(registry.records(changeId).some((entry) => entry.id === id)).toBe(false);

    // It ignores SIGHUP, so only its own loop ends it; wait for that here rather than leaving a
    // live session for the lifecycle stop below (which cannot kill it) to race.
    await waitFor(
      "the lingering session to exit on its own",
      async () => (await (await hostClient()).list()).every((entry) => entry.id !== id || !entry.alive),
      budget(15_000),
    );
  },
  budget(60_000),
);

test("adopts a live pane whose window exists, so a crash mid-split leaves no orphan", async () => {
  const window = await newWindowAsync(changeId, dir);
  // A split that opened its host session but crashed before saving its record: the pane's metadata
  // names the window, so a rebuild adopts it instead of leaving an invisible, immortal shell.
  const orphan = randomUUID();
  await (
    await hostClient()
  ).open(orphan, {
    cwd: dir,
    command: ["/bin/sh"],
    cols: 80,
    rows: 24,
    metadata: { change: changeId, window: window.id, pane: orphan },
  });
  await listWindowsAsync(changeId);
  const record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toContain(orphan);
  expect(record.activePane).not.toBe(orphan); // adoption does not steal the focus
}, 60_000);

test("keeps a window whose other panes exit while a split is in flight", async () => {
  const window = await newWindowAsync(changeId, dir);
  // The split's session exists (metadata names the window) but the window's own pane exits before
  // the split's record is saved. The record would otherwise drop and orphan the new shell.
  const orphan = randomUUID();
  await (
    await hostClient()
  ).open(orphan, {
    cwd: dir,
    command: ["/bin/sh"],
    cols: 80,
    rows: 24,
    metadata: { change: changeId, window: window.id, pane: orphan },
  });
  await (await hostClient()).kill(window.id);
  await waitFor(
    "the window's first pane to exit",
    async () => (await (await hostClient()).list()).some((entry) => entry.id === window.id && !entry.alive),
    15_000,
  );
  await listWindowsAsync(changeId);
  const record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toEqual([orphan]);
}, 60_000);

test("closing the first pane of a split keeps the window id and releases the first pane's screen", async () => {
  const window = await newWindowRunningAsync(changeId, dir, "echo KEEPME; sleep 30", {
    keepOpen: true,
    announce: { label: "Kept", notify: false },
  });
  await splitPaneAsync(changeId, window, "right");
  const first = window; // the first pane's session id is the window id
  expect(isKeptOpen(changeId, first)).toBe(true);

  await closePaneAsync(changeId, window, first);
  const record = registry.records(changeId).find((entry) => entry.id === window)!;
  // The window id is stable; the closed first pane's screen is released, the survivor's is kept.
  expect(record.panes).not.toContain(first);
  expect(isKeptOpen(changeId, first)).toBe(false);
  expect(isKeptOpen(changeId, record.activePane)).toBe(true);
}, 60_000);

test("the socket resolves the pane it names, not the active one", async () => {
  const window = await newWindowAsync(changeId, dir);
  await splitPaneAsync(changeId, window.id, "right");
  const record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  const firstPane = record.panes[0]!;
  const secondPane = record.panes[1]!;
  expect(record.activePane).toBe(secondPane); // the split is focused

  const { openSession, closeAttachments, flushScreens } =
    await import("../apps/server/src/terminals/server/session.ts");
  // The page names the first pane; the session it gets is that pane's, not the active one.
  const session = await openSession(changeId, dir, { cols: 80, rows: 24 }, firstPane);
  expect(session.sessionId).toBe(firstPane);
  flushScreens();
  closeAttachments();
}, 60_000);

test("a named pane that is gone is refused; no other session is attached or created", async () => {
  const staleChange = "REG-STALE";
  const window = await newWindowAsync(staleChange, dir);
  const before = await (await hostClient()).list();
  const beforeIds = new Set(before.map((session) => session.id));

  const { openSession, closeAttachments, flushScreens } =
    await import("../apps/server/src/terminals/server/session.ts");
  // An explicitly named pane that no longer exists fails closed: it must not attach the active
  // window and must not start a shell.
  await expect(openSession(staleChange, dir, { cols: 80, rows: 24 }, "w-gone-pane")).rejects.toThrow(
    /no live pane w-gone-pane/,
  );

  const after = await (await hostClient()).list();
  expect(after.filter((session) => !beforeIds.has(session.id))).toEqual([]);
  expect(registry.records(staleChange).find((record) => record.id === window.id)?.panes).toEqual([window.id]);

  // The ordinary unnamed attach keeps its behavior: the active pane.
  const session = await openSession(staleChange, dir, { cols: 80, rows: 24 });
  expect(session.sessionId).toBe(window.id);
  flushScreens();
  closeAttachments();
  await stopHostTerminals(staleChange);
}, 60_000);

test(
  "completing/cancelling a change stops its host sessions through the lifecycle service",
  async () => {
    expect(ids().length).toBeGreaterThan(0);
    // The product's own stop (the `TerminalSessions` capability `completeChange`/`cancelChange`
    // call), not the raw windows helper: this is the path a completed change takes.
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TerminalSessions, (sessions) =>
          sessions.stop(changeId as Parameters<typeof sessions.stop>[0]),
        ),
        terminalSessionsLayer,
      ),
    );
    expect(registry.records(changeId)).toEqual([]);
    // The host sessions are killed, not merely forgotten.
    await waitFor(
      "the change's host sessions to be gone",
      async () =>
        (await (await hostClient()).list()).every(
          (session) => session.metadata?.change !== changeId || !session.alive,
        ),
      budget(15_000),
    );
  },
  budget(60_000),
);
