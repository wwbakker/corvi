import { basename, join } from "node:path";
import { symlink, lstat, unlink } from "node:fs/promises";
import type { Change, Integration, Widget, WidgetItem, WidgetState } from "../types.ts";
import { sh, shOrThrow, json } from "../sh.ts";
import { config } from "../config.ts";
import { copyTooling } from "../tooling.ts";
import { writeChange, writeWtConfig, changeDir } from "../changes.ts";
import { isMac, commandAvailable } from "../platform.ts";

/**
 * One worktree, in the shape `wt list --format=json` used to hand us.
 *
 * It is read with plain git now: `wt list` costs 1-13 seconds of CPU per call (it gathers far
 * more than this, in parallel), against ~25ms for the two git commands below, and the dashboard
 * asks once per repository per refresh. wt still owns where worktrees live — it creates and
 * removes them — this only reads what is there.
 */
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

export const findWorktree = (entries: WtEntry[], branch: string): WtEntry | undefined =>
  entries.find((e) => e.branch === branch);

/** Where each worktree of `repo` is, and which branch it holds. The main checkout is included,
 * which is what makes a repository used in place look like any other. */
export function parseWorktrees(porcelain: string): { path: string; branch: string }[] {
  const found: { path: string; branch: string }[] = [];
  let path = "";
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    // Detached worktrees have no branch line at all, and belong to no change.
    else if (line.startsWith("branch refs/heads/") && path) {
      found.push({ path, branch: line.slice("branch refs/heads/".length) });
    }
  }
  return found;
}

/** What `git status --porcelain=v2 --branch` says about a working tree. */
export function parseStatus(status: string): NonNullable<WtEntry["working_tree"]> & {
  upstream?: string;
  ahead: number;
  behind: number;
} {
  const lines = status.split("\n");
  const upstream = lines.find((l) => l.startsWith("# branch.upstream "))?.slice(18);
  const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(lines.find((l) => l.startsWith("# branch.ab ")) ?? "");
  // 1 and 2 are tracked changes, u unmerged, ? untracked; the two letters after are the staged
  // and unstaged states, in that order.
  const changes = lines.filter((l) => /^[12u] /.test(l));
  return {
    staged: changes.some((l) => l[2] !== "."),
    modified: changes.some((l) => l[3] !== "."),
    untracked: lines.some((l) => l.startsWith("? ")),
    upstream,
    ahead: Number(ab?.[1] ?? 0),
    behind: Number(ab?.[2] ?? 0),
  };
}

/** The worktree holding this change's branch in `repo`, with everything the dashboard says
 * about it. Undefined when the change has no worktree there. */
export async function entryFor(change: Change, repo: string): Promise<WtEntry | undefined> {
  const worktrees = parseWorktrees(
    (await sh(["git", "worktree", "list", "--porcelain"], repo)).stdout,
  );
  const found = worktrees.find((w) => w.branch === change.branch);
  if (!found) return undefined;

  const [status, base] = await Promise.all([
    sh(["git", "status", "--porcelain=v2", "--branch"], found.path),
    remoteDefaultBranch(repo),
  ]);
  const tree = parseStatus(status.stdout);
  // Whether main already has everything on this branch, which is how a merged change is spotted.
  const beyond = base
    ? Number((await sh(["git", "rev-list", "--count", `${base}..${change.branch}`], repo)).stdout)
    : NaN;
  return {
    branch: change.branch,
    path: found.path,
    working_tree: { staged: tree.staged, modified: tree.modified, untracked: tree.untracked },
    remote: tree.upstream
      ? { branch: tree.upstream, ahead: tree.ahead, behind: tree.behind }
      : null,
    // "diverged" for commits main does not have, which is what makes them worth warning about
    // before a removal. Unknown (no remote to compare with) stays undefined.
    main_state: Number.isNaN(beyond) ? undefined : beyond === 0 ? "integrated" : "diverged",
    is_main: found.path === repo,
  };
}

/** Absolute path of the worktree for `branch` in `repo`, or undefined when it does not exist. */
export async function worktreeFor(change: Change, repo: string): Promise<string | undefined> {
  return (await entryFor(change, repo))?.path;
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
  const entry = await entryFor(change, repo);
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
  return { label, detail: `${detail} · ${entry.path}`, state, menu: openMenu(repo) };
}

/** Remembered for the life of the process: a remote's default branch changes about as often as
 * the repository is renamed, and asking costs two processes. */
const defaultBranches = new Map<string, Promise<string | undefined>>();

/** The remote's default branch, e.g. `origin/main`, or undefined for a repository without a
 * remote. New branches start here rather than at a local main that may be days behind. */
export async function remoteDefaultBranch(repo: string): Promise<string | undefined> {
  const known = defaultBranches.get(repo);
  if (known) return known;
  const asking = askDefaultBranch(repo);
  defaultBranches.set(repo, asking);
  void asking.then((found) => found ?? defaultBranches.delete(repo)); // do not cache "no remote"
  return asking;
}

async function askDefaultBranch(repo: string): Promise<string | undefined> {
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

/**
 * Somewhere to open a repository from its row. macOS applications are opened by name rather than
 * by a command-line launcher, which not everyone installs; `open` is always there.
 *
 * Linux has no application registry to ask, so it opens by command: the file manager through
 * `xdg-open` (as much a given there as Finder's `open` is here), and IntelliJ through the `idea`
 * launcher script — offered only when that launcher is actually installed, checked when the menu
 * is built rather than once at startup, so installing an IDE is enough for the item to appear.
 */
type Opener = {
  id: string;
  label: string;
  command: (path: string) => string[];
  /** Whether the opener can work at all. Undefined means unconditional; a check here keeps a
   * missing tool's item out of the menu rather than presenting a button that fails. */
  available?: () => boolean;
};

export const openers: Opener[] = isMac
  ? [
      {
        id: "open-idea",
        label: "Open in IntelliJ",
        // Handed to the running IntelliJ rather than starting a second one, so it opens the project
        // the way you have it configured (Settings > Appearance & Behavior > System Settings >
        // "Open project in").
        command: (path) => ["open", "-a", "IntelliJ IDEA", path],
      },
      { id: "open-finder", label: "Open in Finder", command: (path) => ["open", path] },
    ]
  : [
      {
        id: "open-idea",
        label: "Open in IntelliJ",
        // The JetBrains launcher script opens the directory as a project in the running IDE when
        // there is one, like `open -a` does on macOS. Only on the menu when `idea` is on PATH.
        command: (path) => ["idea", path],
        available: () => commandAvailable("idea"),
      },
      {
        id: "open-files",
        label: "Open in Files",
        // Opens in whatever file manager the desktop ships; `xdg-open` is on every desktop Linux.
        command: (path) => ["xdg-open", path],
      },
    ];

const openMenu = (repo: string) =>
  openers
    .filter((o) => o.available?.() ?? true)
    .map(({ id, label }) => ({ id, label, arg: repo }));

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
  // --no-track: branching off origin/main would otherwise make origin/main the upstream, and
  // the first `git push` would try to push your work straight onto it. The branch gets its own
  // upstream when it is first pushed, as a worktree's does.
  await shOrThrow(
    ["git", "switch", "--create", change.branch, ...(base ? ["--no-track", base] : [])],
    repo,
  );
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
  // On the right branch: the main checkout is a worktree like any other as far as git is
  // concerned, so the same reading describes it.
  const entry = await entryFor(change, repo);
  const described = entry ? describe(entry) : { detail: dirty ? "uncommitted changes" : "clean", state: dirty ? "pending" : ("ok" as WidgetState) };
  return {
    label,
    detail: `in place · ${described.detail} · ${repo}`,
    state: described.state,
    menu: openMenu(repo),
  };
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
    return await carryTooling(repo, change);
  }
  // Branch from the chosen base, fetched first: a local main is often behind. The base is the
  // remote default unless this change is stacked on another one's branch.
  const base = await baseFor(change, repo);
  if (base) await sh(["git", "fetch", "--quiet", "origin"], repo);
  const baseArgs = base ? ["--base", base] : [];
  await shOrThrow(
    await wt(change, ["-C", repo, "switch", "--create", change.branch, ...baseArgs, "--no-cd"]),
  );
  await carryTooling(repo, change);
}

/**
 * Give the new worktree the IDE and build-tool state the repository has, so opening it is
 * opening a configured project rather than importing one.
 *
 * Never fatal: the worktree is the thing that was asked for, and a change that failed to
 * provision over a copy of `.idea` would be a poor trade.
 */
async function carryTooling(repo: string, change: Change): Promise<void> {
  if (!config.worktreeCopy.length) return;
  const created = await worktreeFor(change, repo);
  if (!created) return;
  try {
    await copyTooling(repo, created, config.worktreeCopy);
  } catch (error) {
    console.error(`could not copy IDE state into ${created}:`, error);
  }
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
  return unsafeIn(await entryFor(change, repo));
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

/**
 * Apply a new repository list in one go: everything added gets a worktree, everything dropped
 * loses one. Refuses the whole edit if any removal would destroy uncommitted work.
 *
 * The list may be emptied. A change with no repositories is not much of a change, but it is a
 * step on the way to one: taking a repository out and putting it back is how you get a fresh
 * worktree when the one you have is beyond saving, and refusing the middle of that made the whole
 * thing impossible. The protections that matter — uncommitted work, unpushed commits — are per
 * repository and still apply.
 */
export async function setRepos(
  change: Change,
  repos: string[],
  force = false,
  direct?: string[],
  base?: Record<string, string>,
): Promise<{ change: Change } | { needsForce: string[] }> {
  const wanted = [...new Set(repos.map((r) => r.trim()).filter(Boolean))];
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

    // Opening: the worktree when there is one, the repository itself when it is used in place.
    const opener = openers.find((o) => o.id === action);
    if (opener) {
      const path = (await worktreeFor(change, repo)) ?? repo;
      await shOrThrow(opener.command(path));
      return;
    }


    // --foreground so the widget refresh that follows sees the removal; --force because build
    // artifacts are untracked files and this button was clicked deliberately.
    if (action === "remove") return removeWorktree(change, repo);
    throw new Error(`unknown git action: ${action}`);
  },
};
