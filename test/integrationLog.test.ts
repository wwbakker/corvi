import { afterAll, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logLine as opencodeLog } from "../integrations/opencode/src/node/log.ts";
import { logLine as piLog } from "../integrations/pi/src/node/log.ts";
import { testTempDir } from "./helpers.ts";

/**
 * The extension log sink. It exists so a Corvi command's own error lands in the app log rather
 * than the subagent's terminal (which Corvi parses, persists and shows as screen output). The two
 * extensions cannot share an import (each is loaded outside Corvi's module graph), so the sink is
 * stated twice; this is what keeps the two statements one.
 */
const dir = await testTempDir("agent-log");

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("with CORVI_LOG, a line is appended with its source and a timestamp", async () => {
  const path = join(dir, "shared.log");
  await writeFile(path, "existing\n");
  const env = { CORVI_LOG: path, CORVI_SUBAGENT_ID: "sub-7" };
  piLog("pi says boom", env);
  opencodeLog("opencode says boom", env);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  // The existing line is untouched: the sink appends.
  expect(lines[0]).toBe("existing");
  expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[sub-7\] pi says boom$/);
  expect(lines[2]).toMatch(/\] \[sub-7\] opencode says boom$/);
});

test("a session id is the source when there is no subagent id", async () => {
  const path = join(dir, "session.log");
  piLog("from a pane", { CORVI_LOG: path, CORVI_SESSION_ID: "w-abc" });
  expect(await readFile(path, "utf8")).toMatch(/\] \[w-abc\] from a pane\n$/);
});

test("without CORVI_LOG, the line falls back to stderr", () => {
  const original = console.error;
  const seen: string[] = [];
  console.error = ((...args: unknown[]) => {
    seen.push(args.join(" "));
  }) as typeof console.error;
  try {
    piLog("plain pi", {});
    opencodeLog("plain opencode", {});
  } finally {
    console.error = original;
  }
  expect(seen).toEqual(["[corvi] plain pi", "[corvi] plain opencode"]);
});

test("the two extensions state the sink once", async () => {
  const pi = await Bun.file("integrations/pi/src/node/log.ts").text();
  const opencode = await Bun.file("integrations/opencode/src/node/log.ts").text();
  expect(opencode).toBe(pi);
});
