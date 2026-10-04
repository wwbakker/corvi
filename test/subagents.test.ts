/** The Subagents page's file operations, against the same isolated config the actions tests
 * use: the shipped profile, a written one, a refused one, and deletion. */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  deleteRepositorySubagentFile,
  deleteSubagentFile,
  repositorySubagentFiles,
  subagentFiles,
  writeRepositorySubagentFile,
  writeSubagentFile,
} from "../apps/server/src/subagents/server/files.ts";
import type { Change } from "@corvi/changes/record";
import { configPath } from "../apps/server/src/workspace/server/index.ts";
import { checkoutsOf, runEffect, runSh, testTempDir } from "./helpers.ts";

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

/** A real checkout, as the repository scope needs one: `checkoutFor` resolves the worktree on
 * the change's own branch, and a committed `git init -b <branch>` repo is its own worktree. */
const repoFixture = async (name: string, branch: string): Promise<string> => {
  const dir = join(own, name);
  await runSh(["git", "init", "-b", branch, dir]);
  await writeFile(join(dir, "README.md"), "hi\n");
  await runSh(["git", "add", "."], dir);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], dir);
  return dir;
};

test("a repository profile is listed, written and deleted through its checkout", async () => {
  const repo = await repoFixture("repo-sub", "PROJ-repo-sub");
  const change = {
    id: "PROJ-repo-sub",
    branch: "PROJ-repo-sub",
    checkouts: checkoutsOf([repo]),
    state: "Implementation",
    createdAt: new Date().toISOString(),
  } as Change;
  // The checkout's own files are listed under the repository's name — problems and all.
  await mkdir(join(repo, ".corvi", "subagents"), { recursive: true });
  await writeFile(join(repo, ".corvi", "subagents", "broken.md"), "---\nlabel: X\n---\nbody\n");
  const before = await runEffect(repositorySubagentFiles(change));
  expect(before.repositories.map((one) => one.repository)).toEqual([basename(repo)]);
  expect(before.repositories[0]?.files.find((f) => f.id === "broken")?.problems).toBeDefined();

  const written = await runEffect(
    writeRepositorySubagentFile(change, { repository: basename(repo), id: "mine", text: mine }),
  );
  expect(written.repositories[0]?.files.find((f) => f.id === "mine")?.label).toBe("My reviewer");

  const gone = await runEffect(
    deleteRepositorySubagentFile(change, { repository: basename(repo), id: "mine" }),
  );
  expect(gone.repositories[0]?.files.find((f) => f.id === "mine")).toBeUndefined();
});

test("a repository the change does not carry is refused rather than invented", async () => {
  const change = {
    id: "PROJ-no-repo",
    branch: "PROJ-no-repo",
    checkouts: checkoutsOf([]),
    state: "Implementation",
    createdAt: new Date().toISOString(),
  } as Change;
  await expect(
    runEffect(writeRepositorySubagentFile(change, { repository: "nope", id: "x", text: mine })),
  ).rejects.toThrow(/no such repository/);
});
