import { basename } from "node:path";
import type { Change, Integration, Widget, WidgetItem, WidgetState } from "../types.ts";
import { sh, shOrThrow, json } from "../sh.ts";
import { writeChange, writeWtConfig } from "../changes.ts";

/** The subset of `wt list --format=json` we use. */
export type WtEntry = {
  branch: string;
  path: string;
  working_tree?: {
    staged?: boolean;
    modified?: boolean;
    untracked?: boolean;
    diff?: { added?: number; deleted?: number };
  };
  remote?: { name?: string; branch?: string; ahead?: number; behind?: number } | null;
  main_state?: string;
  is_main?: boolean;
};

/** Every wt call is scoped to the change's own config, which places worktrees inside the
 * change directory. */
const wt = async (change: Change, args: string[]): Promise<string[]> => [
  "wt",
  "--config",
  await writeWtConfig(change.id),
  ...args,
];

/** Worktrees known to wt in `repo`. wt owns their location, so we ask rather than compute it. */
export async function listWorktrees(change: Change, repo: string): Promise<WtEntry[]> {
  const r = await sh(await wt(change, ["-C", repo, "list", "--format=json"]));
  return r.code === 0 ? json<WtEntry[]>(r.stdout, []) : [];
}

export const findWorktree = (entries: WtEntry[], branch: string): WtEntry | undefined =>
  entries.find((e) => e.branch === branch);

/** Absolute path of the worktree for `branch` in `repo`, or undefined when it does not exist. */
export async function worktreeFor(change: Change, repo: string): Promise<string | undefined> {
  return findWorktree(await listWorktrees(change, repo), change.branch)?.path;
}

/** Human summary of one worktree, and how alarming it is. */
export function describe(entry: WtEntry): { detail: string; state: WidgetState } {
  const tree = entry.working_tree ?? {};
  const dirty = Boolean(tree.staged || tree.modified || tree.untracked);
  const ahead = entry.remote?.ahead ?? 0;
  const behind = entry.remote?.behind ?? 0;
  const parts = [dirty ? "uncommitted changes" : "clean"];
  if (!entry.remote?.branch) parts.push("no upstream");
  if (ahead) parts.push(`${ahead} unpushed`);
  if (behind) parts.push(`${behind} behind`);
  if (entry.main_state === "integrated") parts.push("merged");
  return {
    detail: parts.join(", "),
    state: dirty || ahead || !entry.remote?.branch ? "pending" : "ok",
  };
}

async function repoItem(change: Change, repo: string): Promise<WidgetItem> {
  const label = basename(repo);
  const entry = findWorktree(await listWorktrees(change, repo), change.branch);
  if (!entry) {
    return {
      label,
      detail: "no worktree",
      state: "none",
      actions: [{ id: "add", label: "Create worktree", arg: repo }],
    };
  }
  const { detail, state } = describe(entry);
  // Adding and removing repositories happens in the edit dialog, not per row.
  return { label, detail: `${detail} · ${entry.path}`, state };
}

/** The remote's default branch, e.g. `origin/main`, or undefined for a repository without a
 * remote. New branches start here rather than at a local main that may be days behind. */
export async function remoteDefaultBranch(repo: string): Promise<string | undefined> {
  if (!(await sh(["git", "remote"], repo)).stdout) return undefined;
  const read = async (): Promise<string | undefined> => {
    const r = await sh(
      ["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      repo,
    );
    return r.code === 0 && r.stdout ? r.stdout : undefined;
  };
  const known = await read();
  if (known) return known;
  // A clone made with --single-branch has no origin/HEAD until it is asked for.
  await sh(["git", "remote", "set-head", "origin", "-a"], repo);
  return (await read()) ?? "origin/main";
}

/** Create the worktree for this change in `repo`; existing ones are left alone. */
async function createWorktree(change: Change, repo: string): Promise<void> {
  if (await worktreeFor(change, repo)) return;
  const exists =
    (await sh(["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`], repo))
      .code === 0;
  // --no-cd: we are not a shell, wt must not try to change directory on our behalf.
  if (exists) {
    await shOrThrow(await wt(change, ["-C", repo, "switch", change.branch, "--no-cd"]));
    return;
  }
  // Branch from the remote's default branch, fetched first: a local main is often behind.
  const base = await remoteDefaultBranch(repo);
  if (base) await sh(["git", "fetch", "--quiet", "origin"], repo);
  const baseArgs = base ? ["--base", base] : [];
  await shOrThrow(
    await wt(change, ["-C", repo, "switch", "--create", change.branch, ...baseArgs, "--no-cd"]),
  );
}

/** Work a removal would throw away: uncommitted changes cannot be recovered at all, unpushed
 * commits survive in the reflog but not anywhere anyone else can see. */
export type Unsafe = { kind: "dirty" | "unpushed"; text: string };

/** wt's view of the branch against main: anything else means commits main does not have. */
const inMain = (state?: string): boolean =>
  ["is_main", "integrated", "empty", undefined].includes(state);

export function unsafeIn(entry: WtEntry | undefined): Unsafe | undefined {
  if (!entry) return undefined; // nothing to lose
  const tree = entry.working_tree ?? {};
  if (tree.staged || tree.modified || tree.untracked) {
    return { kind: "dirty", text: "uncommitted changes" };
  }
  // Commits ahead of the upstream, or commits on a branch that was never pushed at all: both
  // disappear with the worktree, since wt deletes the branch along with it.
  const ahead = entry.remote?.ahead ?? 0;
  if (ahead > 0) return { kind: "unpushed", text: `${ahead} unpushed commit(s)` };
  if (!entry.remote?.branch && !inMain(entry.main_state)) {
    return { kind: "unpushed", text: "commits that were never pushed" };
  }
  return undefined;
}

export async function unsafeToRemove(change: Change, repo: string): Promise<Unsafe | undefined> {
  return unsafeIn(findWorktree(await listWorktrees(change, repo), change.branch));
}

/** The repositories of a change, with what a removal would destroy: the edit dialog needs both. */
export async function repoStates(
  change: Change,
): Promise<{ path: string; name: string; unsafe?: Unsafe }[]> {
  return Promise.all(
    change.repos.map(async (path) => ({
      path,
      name: basename(path),
      unsafe: await unsafeToRemove(change, path),
    })),
  );
}

/** Apply a new repository list in one go: everything added gets a worktree, everything dropped
 * loses one. Refuses the whole edit if any removal would destroy uncommitted work. */
export async function setRepos(
  change: Change,
  repos: string[],
  force = false,
): Promise<{ change: Change } | { needsForce: string[] }> {
  const wanted = [...new Set(repos.map((r) => r.trim()).filter(Boolean))];
  if (wanted.length === 0) throw new Error("a change needs at least one repository");
  const removed = change.repos.filter((r) => !wanted.includes(r));
  const added = wanted.filter((r) => !change.repos.includes(r));

  const unsafe = await Promise.all(
    removed.map(async (repo) => ({ repo, unsafe: await unsafeToRemove(change, repo) })),
  );
  const dirty = unsafe.filter((u) => u.unsafe?.kind === "dirty");
  if (dirty.length) {
    throw new Error(
      `${dirty.map((d) => basename(d.repo)).join(", ")}: uncommitted changes, revert or commit them first`,
    );
  }
  const unpushed = unsafe.filter((u) => u.unsafe?.kind === "unpushed");
  if (unpushed.length && !force) return { needsForce: unpushed.map((u) => basename(u.repo)) };

  for (const repo of removed) await removeWorktree(change, repo);
  const updated: Change = { ...change, repos: wanted };
  await writeChange(updated);
  for (const repo of added) await createWorktree(updated, repo);
  return { change: updated };
}

/** Drop the worktree once its work is merged; the branch goes with it. */
export async function removeWorktree(change: Change, repo: string): Promise<void> {
  if (!(await worktreeFor(change, repo))) return;
  await shOrThrow(
    await wt(change, ["-C", repo, "remove", "--yes", "--foreground", "--force", change.branch]),
  );
}

export const git: Integration = {
  name: "git",
  title: "Local changes",

  async repoStatus(change: Change, repo: string): Promise<WidgetItem[]> {
    return [await repoItem(change, repo)];
  },

  async provision(change: Change): Promise<void> {
    for (const repo of change.repos) await createWorktree(change, repo);
  },

  async run(change: Change, action: string, repo?: string): Promise<void> {
    if (!repo) throw new Error("repo required");
    if (action === "add") return createWorktree(change, repo);


    // --foreground so the widget refresh that follows sees the removal; --force because build
    // artifacts are untracked files and this button was clicked deliberately.
    if (action === "remove") return removeWorktree(change, repo);
    throw new Error(`unknown git action: ${action}`);
  },
};
