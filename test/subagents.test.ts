/** The Subagents page's file operations, against the same isolated config the actions tests
 * use: the shipped profile, a written one, a refused one, and deletion. */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  deleteSubagentFile,
  subagentFiles,
  writeSubagentFile,
} from "../apps/server/src/subagents/server/files.ts";
import { configPath } from "../apps/server/src/workspace/server/index.ts";
import { runEffect, testTempDir } from "./helpers.ts";

const own = await testTempDir("subagents");
process.env.CORVI_CONFIG = join(own, "config.json");
await mkdir(join(own, "subagents"), { recursive: true });
await writeFile(configPath(), "{}");

const mine = "---\nlabel: My reviewer\nharness: pi\neffort: high\n---\nReview {prompt}\n";

test("the page lists the shipped profiles and the workspaces that can hold files", async () => {
  const listing = await runEffect(subagentFiles());
  const reviewer = listing.files.find((file) => file.id === "reviewer");
  expect(reviewer?.scope).toBe("builtin");
  expect(reviewer?.label).toBe("Reviewer");
  expect(reviewer?.problems).toBeUndefined();
  expect(listing.workspaces.length).toBeGreaterThan(0);
});

test("a written profile is listed with its label; one that is not a profile is refused with reasons", async () => {
  const after = await runEffect(writeSubagentFile({ scope: "global", id: "mine", text: mine }));
  const found = after.files.find((file) => file.id === "mine");
  expect(found?.label).toBe("My reviewer");
  expect(found?.scope).toBe("global");

  await expect(
    runEffect(writeSubagentFile({ scope: "global", id: "broken", text: "---\nlabel: X\n---\nbody" })),
  ).rejects.toThrow(/harness/);
});

test("an unknown workspace is refused rather than invented", async () => {
  await expect(
    runEffect(writeSubagentFile({ scope: "workspace", workspace: "nope", id: "mine", text: mine })),
  ).rejects.toThrow(/no such workspace/);
});

test("deleting a written profile brings the shipped one back", async () => {
  const after = await runEffect(deleteSubagentFile({ scope: "global", id: "mine" }));
  expect(after.files.find((file) => file.id === "mine")).toBeUndefined();
  expect(after.files.find((file) => file.id === "reviewer" && file.scope === "builtin")).toBeDefined();
});

test("saving a built-in profile's id in Global shadows it, and deleting the copy brings it back", async () => {
  const shadow = "---\nlabel: My reviewer\nharness: opencode\n---\nMine\n";
  const written = await runEffect(writeSubagentFile({ scope: "global", id: "reviewer", text: shadow }));
  expect(written.files.find((file) => file.id === "reviewer" && file.scope === "global")?.label).toBe(
    "My reviewer",
  );
  // The shipped file is still listed (it is on disk) but the global copy wins discovery.
  const restored = await runEffect(deleteSubagentFile({ scope: "global", id: "reviewer" }));
  expect(restored.files.find((file) => file.id === "reviewer" && file.scope === "global")).toBeUndefined();
  expect(restored.files.find((file) => file.id === "reviewer" && file.scope === "builtin")?.label).toBe(
    "Reviewer",
  );
});

test("an id that is a path is refused rather than written outside the scope", async () => {
  await expect(
    runEffect(writeSubagentFile({ scope: "global", id: "../escape", text: mine })),
  ).rejects.toThrow(/file name/);
});
