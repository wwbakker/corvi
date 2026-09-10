import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { absolutePath, browse, remoteBranches, resolveInRoot, startPath } from "../src/repos.ts";
import { fakeShell, runEffect, runWithShell } from "./helpers.ts";

/**
 * The repository browser: what is inside a directory, what counts as a repository, and what a
 * new branch can start from. The first two are filesystem reads; the branches are git reads,
 * driven here through the scripted Shell.
 */
let tmp: string;
const originalRoot = config.reposRoot;
const originalStart = config.reposStart;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-browse-"));
  config.reposRoot = tmp;
});

afterAll(async () => {
  config.reposRoot = originalRoot;
  config.reposStart = originalStart;
  await rm(tmp, { recursive: true, force: true });
});

test("browse: visible directories only, a repository either way .git is stored", async () => {
  await mkdir(join(tmp, "alpha", ".git"), { recursive: true });
  await mkdir(join(tmp, "alpha", "inner"), { recursive: true });
  await mkdir(join(tmp, "beta"), { recursive: true });
  // A worktree stores .git as a file, and it is still a repository.
  await writeFile(join(tmp, "beta", ".git"), "gitdir: ../.git/worktrees/beta\n");
  await mkdir(join(tmp, "zeta"), { recursive: true });
  await mkdir(join(tmp, ".hidden"), { recursive: true });
  await writeFile(join(tmp, "notes.txt"), "not a directory\n");

  const atRoot = await runEffect(browse(""));
  expect(atRoot.root).toBe(tmp);
  expect(atRoot.path).toBe("");
  expect(atRoot.entries.map((e) => e.name)).toEqual(["alpha", "beta", "zeta"]);
  expect(atRoot.entries.map((e) => e.path)).toEqual(["alpha", "beta", "zeta"]);
  expect(atRoot.entries.map((e) => e.isRepo)).toEqual([true, true, false]);

  // A nested path is relative to the root throughout, so going up stays possible.
  const nested = await runEffect(browse("alpha"));
  expect(nested.path).toBe("alpha");
  expect(nested.entries.map((e) => [e.path, e.isRepo])).toEqual([["alpha/inner", false]]);
});

test("startPath: the configured start is relative to the root, empty when it is not inside", () => {
  config.reposStart = join(tmp, "alpha");
  expect(startPath()).toBe("alpha");

  config.reposStart = tmp;
  expect(startPath()).toBe("");

  config.reposStart = join(tmp, "..", "somewhere");
  expect(startPath()).toBe("");

  // The browser opens there by default, without an explicit path argument.
  config.reposStart = join(tmp, "alpha");
});

test("browse defaults to the configured start directory", async () => {
  config.reposStart = join(tmp, "alpha");
  const opened = await runEffect(browse());
  expect(opened.path).toBe("alpha");
  expect(opened.entries.map((e) => e.name)).toEqual(["inner"]);
});

test("resolveInRoot and absolutePath: inside the root is resolved, escaping is refused", () => {
  expect(resolveInRoot("alpha")).toBe(join(tmp, "alpha"));
  expect(resolveInRoot("")).toBe(tmp);
  expect(resolveInRoot(".")).toBe(tmp);
  // Normalization happens before the check, so a path that only looks like traversal is fine.
  expect(resolveInRoot("alpha/../beta")).toBe(join(tmp, "beta"));
  expect(absolutePath("alpha")).toBe(join(tmp, "alpha"));

  expect(() => resolveInRoot("../outside")).toThrow("outside repos root");
  expect(() => resolveInRoot("alpha/../../outside")).toThrow("outside repos root");
  expect(() => absolutePath("../outside")).toThrow("outside repos root");
  expect(runEffect(browse("../outside"))).rejects.toThrow("outside repos root");
});

test("browse: a directory that is gone is a defect, not a silent empty listing", async () => {
  expect(runEffect(browse("never-created"))).rejects.toThrow();
});

test("remoteBranches: the remote default leads, and non-branches are filtered out", async () => {
  const repo = join(tmp, "remote-default");
  const shell = fakeShell({
    "git fetch --quiet --prune --no-tags origin": "",
    "git remote": "origin",
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main",
    "git for-each-ref --sort=-committerdate --format=%(refname:short) refs/remotes":
      "origin/feature\norigin/main\norigin/HEAD\norigin\nupstream/x\n",
  });

  const found = await runWithShell(shell, remoteBranches(repo));
  expect(found.default).toBe("origin/main");
  // origin/HEAD is a symref and a bare remote name has no branch; the default is not repeated.
  expect(found.branches).toEqual(["origin/main", "origin/feature", "upstream/x"]);
  // Fetched and pruned first: a stale list would offer a base that is behind or gone.
  expect(shell.calls.map((c) => c.cmd.join(" "))).toContain(
    "git fetch --quiet --prune --no-tags origin",
  );
});

test("remoteBranches: a repository with no remote has no default", async () => {
  const repo = join(tmp, "remote-none");
  const shell = fakeShell({
    "git fetch --quiet --prune --no-tags origin": "",
    "git remote": "",
    "git for-each-ref --sort=-committerdate --format=%(refname:short) refs/remotes":
      "origin/main\norigin/dev\n",
  });

  const found = await runWithShell(shell, remoteBranches(repo));
  expect(found.default).toBeUndefined();
  expect(found.branches).toEqual(["origin/main", "origin/dev"]);
});

test("remoteBranches: a clone without origin/HEAD falls back to origin/main", async () => {
  const repo = join(tmp, "remote-sethead");
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "git remote") return "origin";
    // A single-branch clone has no origin/HEAD until it is asked for, and this one never
    // answers with one: the fallback is the last resort.
    if (line === "git symbolic-ref --quiet --short refs/remotes/origin/HEAD") return "";
    if (line === "git for-each-ref --sort=-committerdate --format=%(refname:short) refs/remotes")
      return "origin/main\norigin/topic\n";
    return "";
  });

  const found = await runWithShell(shell, remoteBranches(repo));
  expect(found.default).toBe("origin/main");
  expect(found.branches).toEqual(["origin/main", "origin/topic"]);
  expect(shell.calls.map((c) => c.cmd.join(" "))).toContain("git remote set-head origin -a");
});

test("remoteBranches: a failed fetch does not take the branch list down", async () => {
  const repo = join(tmp, "remote-fetch-fail");
  const shell = fakeShell({
    "git fetch --quiet --prune --no-tags origin": { code: 128, stderr: "could not read from remote" },
    "git remote": "origin",
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main",
    "git for-each-ref --sort=-committerdate --format=%(refname:short) refs/remotes":
      "origin/main\n",
  });

  const found = await runWithShell(shell, remoteBranches(repo));
  expect(found.default).toBe("origin/main");
  expect(found.branches).toEqual(["origin/main"]);
});
