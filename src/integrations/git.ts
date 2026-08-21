import { basename, join } from "node:path";
import { symlink, lstat, unlink } from "node:fs/promises";
import type { Change, Integration, Widget, WidgetItem, WidgetState } from "../types.ts";
import { sh, shOrThrow, json } from "../sh.ts";
import { writeChange, writeWtConfig, changeDir } from "../changes.ts";

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
  if (isDirect(change, repo)) return directItem(change, repo);
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

/** The branch this repository's work starts from: what you chose, or the remote's default. */
export async function baseFor(change: Change, repo: string): Promise<string | undefined> {
  return change.base?.[repo] ?? (await remoteDefaultBranch(repo));
}

/** Repositories worked on in place rather than through a worktree. */
export const isDirect = (change: Change, repo: string): boolean =>
  change.direct?.includes(repo) ?? false;

/** Where the change directory links to a repository used in place, so the change directory
 * still shows everything the change touches. */
const linkPath = (change: Change, repo: string): string => join(changeDir(change.id), basename(repo));

export const currentBranch = async (repo: string): Promise<string> =>
  (await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout;

export const isDirty = async (repo: string): Promise<boolean> =>
  (await sh(["git", "status", "--porcelain"], repo)).stdout !== "";

/**
 * Work in the repository itself: link it from the change directory and put its checkout on the
 * change's branch, freshly branched off the remote default like a worktree would be.
 *
 * A repository with uncommitted work is linked but not touched otherwise: switching branches
 * under half-finished edits is the kind of help nobody wants. The widget then says so, and the
 * action can be repeated once the tree is clean.
 */
async function useInPlace(change: Change, repo: string): Promise<void> {
  await symlink(repo, linkPath(change, repo)).catch(() => {}); // already linked
  if ((await currentBranch(repo)) === change.branch) return;
  if (await isDirty(repo)) return; // reported by the widget; the user decides what to do
  const exists =
    (await sh(["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`], repo))
      .code === 0;
  if (exists) {
    await shOrThrow(["git", "switch", change.branch], repo);
    return;
  }
  const base = await baseFor(change, repo);
  if (base) await sh(["git", "fetch", "--quiet", "origin"], repo);
  await shOrThrow(["git", "switch", "--create", change.branch, ...(base ? [base] : [])], repo);
}

/** Stop using a repository in place: the link goes, the checkout stays exactly as it is. */
async function unlinkInPlace(change: Change, repo: string): Promise<void> {
  const path = linkPath(change, repo);
  if (await lstat(path).then(() => true, () => false)) await unlink(path);
}

/** How a repository used in place stands: which branch it is on, and whether it needs a hand. */
async function directItem(change: Change, repo: string): Promise<WidgetItem> {
  const label = basename(repo);
  const [branch, dirty] = await Promise.all([currentBranch(repo), isDirty(repo)]);
  if (branch !== change.branch) {
    return {
      label,
      detail: dirty
        ? `in place, on ${branch} with uncommitted changes — commit or stash, then switch to ${change.branch} yourself`
        : `in place, on ${branch}`,
      detailTone: "warn",
      state: "warn",
      actions: [{ id: "add", label: `Switch to ${change.branch}`, arg: repo }],
    };
  }
  // On the right branch: wt's own listing describes the main checkout as well as a worktree.
  const entry = findWorktree(await listWorktrees(change, repo), change.branch);
  const described = entry ? describe(entry) : { detail: dirty ? "uncommitted changes" : "clean", state: dirty ? "pending" : ("ok" as WidgetState) };
  return { label, detail: `in place · ${described.detail} · ${repo}`, state: described.state };
}

/** Create the worktree for this change in `repo`; existing ones are left alone. */
async function createWorktree(change: Change, repo: string): Promise<void> {
  if (isDirect(change, repo)) return useInPlace(change, repo);
  if (await worktreeFor(change, repo)) return;
  const exists =
    (await sh(["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`], repo))
      .code === 0;
  // --no-cd: we are not a shell, wt must not try to change directory on our behalf.
  if (exists) {
    await shOrThrow(await wt(change, ["-C", repo, "switch", change.branch, "--no-cd"]));
    return;
  }
  // Branch from the chosen base, fetched first: a local main is often behind. The base is the
  // remote default unless this change is stacked on another one's branch.
  const base = await baseFor(change, repo);
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
  // Commits ahead of the upstream, or commits on a branch that was never pushed at all. The
  // branch itself survives a removal while it is unmerged, but the worktree they were made in
  // does not, and nothing else points at them: worth a question before going ahead.
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
): Promise<{ path: string; name: string; direct: boolean; base?: string; unsafe?: Unsafe }[]> {
  return Promise.all(
    change.repos.map(async (path) => ({
      path,
      name: basename(path),
      direct: isDirect(change, path),
      base: await baseFor(change, path),
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
  direct?: string[],
  base?: Record<string, string>,
): Promise<{ change: Change } | { needsForce: string[] }> {
  const wanted = [...new Set(repos.map((r) => r.trim()).filter(Boolean))];
  if (wanted.length === 0) throw new Error("a change needs at least one repository");
  const wantedDirect = (direct ?? change.direct ?? []).filter((r) => wanted.includes(r));
  // A repository whose mode changed is torn down and set up again: the old worktree or link is
  // as wrong as a repository that was dropped.
  const switched = wanted.filter((r) => isDirect(change, r) !== wantedDirect.includes(r));
  const removed = [...change.repos.filter((r) => !wanted.includes(r)), ...switched];
  const added = [...wanted.filter((r) => !change.repos.includes(r)), ...switched];

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
  const bases = Object.fromEntries(
    Object.entries(base ?? change.base ?? {}).filter(([repo]) => wanted.includes(repo)),
  );
  const updated: Change = {
    ...change,
    repos: wanted,
    direct: wantedDirect.length ? wantedDirect : undefined,
    base: Object.keys(bases).length ? bases : undefined,
  };
  await writeChange(updated);
  for (const repo of added) await createWorktree(updated, repo);
  return { change: updated };
}

/**
 * Drop the worktree. wt deletes the branch with it when it has been merged, and keeps it when it
 * has not — which is what makes switching a repository to in-place work: the worktree goes, the
 * branch stays, and the repository's own checkout picks it up.
 */
export async function removeWorktree(change: Change, repo: string): Promise<void> {
  if (isDirect(change, repo)) return unlinkInPlace(change, repo);
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
