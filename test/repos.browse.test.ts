import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  browse,
  runtimeConfig,
  remoteBranches,
  repositoriesDirectoryOf,
  resolveDirectory,
} from "../apps/server/src/workspace/server/index.ts";
import type { Workspace } from "@corvi/configuration/config";
import { fakeShell, runEffect, runWithShell } from "./helpers.ts";

/**
 * The repository browser: what is inside a directory, what counts as a repository, and what a
 * new branch can start from. The first two are filesystem reads; the branches are git reads,
 * driven here through the scripted Shell. The browser is unbounded — any absolute directory can
 * be listed — so these tests are about what a listing contains, not about what it refuses.
 */
let tmp: string;
const original = runtimeConfig().repositoriesDirectory;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-browse-"));
  runtimeConfig().repositoriesDirectory = tmp;
});

afterAll(async () => {
  runtimeConfig().repositoriesDirectory = original;
  await rm(tmp, { recursive: true, force: true });
});

test("browse: directories only, dot-directories withheld unless asked for, .git either way", async () => {
  await mkdir(join(tmp, "alpha", ".git"), { recursive: true });
  await mkdir(join(tmp, "alpha", "inner"), { recursive: true });
  await mkdir(join(tmp, "beta"), { recursive: true });
  // A worktree stores .git as a file, and it is still a repository.
  await writeFile(join(tmp, "beta", ".git"), "gitdir: ../.git/worktrees/beta\n");
  await mkdir(join(tmp, "zeta"), { recursive: true });
  await mkdir(join(tmp, ".hidden"), { recursive: true });
  await writeFile(join(tmp, "notes.txt"), "not a directory\n");

  const atRoot = await runEffect(browse(tmp));
  expect(atRoot.path).toBe(tmp);
  // Hidden directories are withheld unless the request asks for them.
  expect(atRoot.entries.map((e) => e.name)).toEqual(["alpha", "beta", "zeta"]);
  // Every path is absolute, which is what the client navigates and selects by.
  expect(atRoot.entries.map((e) => e.path)).toEqual([
    join(tmp, "alpha"),
    join(tmp, "beta"),
    join(tmp, "zeta"),
  ]);
  expect(atRoot.entries.map((e) => e.isRepo)).toEqual([true, true, false]);

  // `hidden` is the request's own word for them, so the listing carries what it will show.
  const withHidden = await runEffect(browse(tmp, true));
  expect(withHidden.entries.map((e) => e.name)).toEqual([".hidden", "alpha", "beta", "zeta"]);

  // A nested path lists what is under it, and a file beside the directories is not a row.
  const nested = await runEffect(browse(join(tmp, "alpha")));
  expect(nested.path).toBe(join(tmp, "alpha"));
  expect(nested.entries.map((e) => [e.path, e.isRepo])).toEqual([
    [join(tmp, "alpha", "inner"), false],
  ]);
  expect((await runEffect(browse(join(tmp, "alpha"), true))).entries.map((e) => e.name)).toEqual([
    ".git",
    "inner",
  ]);
});

test("browse follows symlinks: a linked directory is a directory to browse", async () => {
  // macOS' /etc, /tmp and /var are symlinks, and so is a checkout reached through one. A
  // dirent's isDirectory() would answer false and the directory would simply not appear.
  const real = await mkdtemp(join(tmpdir(), "corvi-browse-real-"));
  await mkdir(join(real, "linked"), { recursive: true });
  await symlink(real, join(tmp, "via-link"));

  const linked = await runEffect(browse(join(tmp, "via-link")));
  expect(linked.entries.map((e) => e.name)).toEqual(["linked"]);
  await rm(real, { recursive: true, force: true });
});

test("browse defaults to the configured repositories directory", async () => {
  const opened = await runEffect(browse());
  expect(opened.path).toBe(tmp);
});

test("resolveDirectory: ~ is expanded, a path is normalized, a relative one is refused", () => {
  expect(resolveDirectory(tmp)).toBe(tmp);
  expect(resolveDirectory(join(tmp, "alpha", "..", "beta"))).toBe(join(tmp, "beta"));

  expect(resolveDirectory("~")).toBe(homedir());
  expect(resolveDirectory("~/Repos")).toBe(join(homedir(), "Repos"));

  expect(() => resolveDirectory("alpha")).toThrow("not an absolute path");
  expect(() => resolveDirectory("")).toThrow("not an absolute path");
});

test("repositoriesDirectoryOf: the workspace's own directory, else the global one", () => {
  const own: Workspace = {
    id: "client",
    name: "Client",
    settings: { repositoriesDirectory: join(tmp, "client-repos") },
  };
  expect(repositoriesDirectoryOf(own)).toBe(join(tmp, "client-repos"));
  // A context that names none inherits the global setting, which is the point of the fallback.
  expect(repositoriesDirectoryOf({ id: "own", name: "Own" })).toBe(tmp);
});

test("browse: a directory that is gone is a defect, not a silent empty listing", async () => {
  expect(runEffect(browse(join(tmp, "never-created")))).rejects.toThrow();
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
