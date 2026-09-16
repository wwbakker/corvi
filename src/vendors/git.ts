import { basename, join } from "node:path";
import { symlink, lstat, unlink } from "node:fs/promises";
import { Effect } from "effect";
import type { Change } from "../domain/change.ts";
import { isIdeation } from "../domain/change.ts";
import type { Widget, WidgetItem, WidgetState } from "../domain/widget.ts";
import { shOrThrow } from "../capabilities/shell.ts";
import { config } from "../workspace/server/index.ts";
import { copyTooling } from "../capabilities/os.ts";
import { writeChange, writeWtConfig, changeDir } from "../change/server/store.ts";
import { isMac, commandAvailable } from "../capabilities/os.ts";
import { BadRequestError, type CliError } from "../capabilities/effect/errors.ts";
import { fs, messageOf, shSoft } from "../capabilities/effect/support.ts";

/**
 * One worktree, as the dashboard reads it.
 *
 * Plain git reads it: `wt list` costs 1-13 seconds of CPU per call (it gathers far more than
 * this, in parallel), against ~25ms for the two git commands below, and the dashboard asks once
 * per repository per refresh. wt still owns where worktrees live — it creates and removes them —
 * this only reads what is there.
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

// Pure worktree parsing and status reading live here; the test suites reach the Effect API
// through the helper in test/helpers.ts, which provides the Workspace tag.

/** Every wt call is scoped to the change's own config, which places worktrees inside the
 * change directory. */
const wt = (change: Change, args: string[]): Effect.Effect<string[]> =>
  Effect.map(writeWtConfig(change.id), (configPath) =>
    ["wt", "--config", configPath, ...args]);

// Pure and synchronous: nothing for an Effect to wrap.
export const findWorktree = (entries: WtEntry[], branch: string): WtEntry | undefined =>
  entries.find((e) => e.branch === branch);

/** Where each worktree of `repo` is, and which branch it holds. The main checkout is included,
 * which is what makes a repository used in place look like any other. */
// Pure and synchronous: nothing for an Effect to wrap.
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
// Pure and synchronous: nothing for an Effect to wrap.
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

/** Whether every commit on `branch` beyond `base` is patch-identical to a copy upstream — what
 * a squash merge leaves behind, whose commits are never ancestors of main. `git cherry` marks
 * each commit `+` (missing upstream) or `-` (patch-identical copy upstream), so all `-` means
 * the content landed. Assumes the branch has commits beyond `base`; `contentInMain` establishes
 * that. A non-zero exit or unparseable output is "not proven", not an error — this only ever
 * adds a ready path, so doubt reads as blocked. */
const cherryInMain = (
  repo: string,
  branch: string,
  base: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const cherry = yield* shSoft(["git", "cherry", base, branch], repo);
    if (cherry.code !== 0) return false;
    const marks = cherry.stdout.split("\n").filter(Boolean);
    return marks.length > 0 && marks.every((line) => line.startsWith("- "));
  });

/** Whether every commit on `branch` is already in the remote's default branch: either
 * main contains the branch outright, or it contains patch-identical copies of every commit —
 * what a squash merge leaves behind, whose commits are never ancestors of main. Local refs
 * only, so callers that need the truth fetch first; routed through `sh` like the rest, so a
 * test scripts it like any other command. `base` is the same one `entryFor` compares
 * against: a change stacked on another one's branch is measured against that, not main. */
export const contentInMain = (
  repo: string,
  branch: string,
  base: string | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!base) return false;
    // Nothing beyond main: the branch is contained outright, no cherry needed. An empty or
    // unparseable count is "not proven", not zero — `Number("")` is 0, which would read
    // every failed lookup as merged.
    const raw = (yield* shSoft(["git", "rev-list", "--count", `${base}..${branch}`], repo)).stdout.trim();
    if (!/^\d+$/.test(raw)) return false;
    if (Number(raw) === 0) return true;
    return yield* cherryInMain(repo, branch, base);
  });

/** The worktree holding this change's branch in `repo`, with everything the dashboard says
 * about it. Undefined when the change has no worktree there. */
export const entryFor = (change: Change, repo: string): Effect.Effect<WtEntry | undefined> =>
  Effect.gen(function* () {
    const worktrees = parseWorktrees(
      (yield* shSoft(["git", "worktree", "list", "--porcelain"], repo)).stdout,
    );
    const found = worktrees.find((w) => w.branch === change.branch);
    if (!found) return undefined;

    const [status, base] = yield* Effect.all([
      shSoft(["git", "status", "--porcelain=v2", "--branch"], found.path),
      remoteDefaultBranch(repo),
    ]);
    const tree = parseStatus(status.stdout);
    // Whether main already has everything on this branch, which is how a merged change is spotted.
    // An empty or unparseable count is unknown, not zero: `Number("")` is 0, which would read
    // a failed lookup as merged. Beyond rev-list containment, patch-identical content counts:
    // a squash merge leaves commits main has the content of but not the ancestry of.
    const raw = base
      ? (yield* shSoft(["git", "rev-list", "--count", `${base}..${change.branch}`], repo)).stdout.trim()
      : "";
    const beyond = /^\d+$/.test(raw) ? Number(raw) : NaN;
    // The rev-list count is already in hand, so only the cherry half runs here; `contentInMain`
    // would re-run the count.
    const integrated =
      beyond === 0 ||
      (!Number.isNaN(beyond) && beyond > 0 && (yield* cherryInMain(repo, change.branch, base!)));
    return {
      branch: change.branch,
      path: found.path,
      working_tree: { staged: tree.staged, modified: tree.modified, untracked: tree.untracked },
      remote: tree.upstream
        ? { branch: tree.upstream, ahead: tree.ahead, behind: tree.behind }
        : null,
      // "diverged" for commits main does not have, which is what makes them worth warning about
      // before a removal. Unknown (no remote to compare with) stays undefined. Patch-identical
      // content counts as integrated: a squash merge lands the content without the ancestry.
      main_state: Number.isNaN(beyond) ? undefined : integrated ? "integrated" : "diverged",
      is_main: found.path === repo,
    };
  });

/** Absolute path of the worktree for `branch` in `repo`, or undefined when it does not exist. */
/** Where this change's checkout of `repo` lives: its worktree, or — worked on in place — the
 * repository's own checkout, which is the path the change directory's link points at too.
 * Undefined when the change has no checkout of this repository. */
export const checkoutFor = (change: Change, repo: string): Effect.Effect<string | undefined> =>
  Effect.map(entryFor(change, repo), (entry) => entry?.path);

/** Human summary of one checkout — the worktree or the in-place repository — and how
 * alarming it is. */
// Pure and synchronous: nothing for an Effect to wrap.
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

export const repoItem = (change: Change, repo: string): Effect.Effect<WidgetItem> =>
  Effect.gen(function* () {
    // An idea's repositories are only linked for reading: no branch is switched and no worktree
    // exists, so the row says that instead of offering to create one. Checked before `direct`,
    // since which mode the work will use is a decision for the start, not for the idea.
    if (isIdeation(change)) {
      return {
        label: basename(repo),
        detail: `linked for browsing · ${repo}`,
        state: "none",
        menu: openMenu(repo),
      };
    }
    if (isDirect(change, repo)) return yield* directItem(change, repo);
    const label = basename(repo);
    const entry = yield* entryFor(change, repo);
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
  });

/** One shared memoized ask per repository: a remote's default branch changes about as often as
 * the repository is renamed, and asking costs two processes. A repository without a remote (or
 * whose ask failed) is not cached, so the next caller asks again and no stale answer is left
 * behind. */
const defaultBranches = new Map<string, Effect.Effect<string | undefined>>();

const askDefaultBranch = (repo: string): Effect.Effect<string | undefined, CliError> =>
  Effect.gen(function* () {
    if (!(yield* shSoft(["git", "remote"], repo)).stdout) return undefined;
    const read = (): Effect.Effect<string | undefined> =>
      Effect.map(
        shSoft(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo),
        (r) => (r.code === 0 && r.stdout ? r.stdout : undefined),
      );
    const known = yield* read();
    if (known) return known;
    // A clone made with --single-branch has no origin/HEAD until it is asked for.
    yield* shSoft(["git", "remote", "set-head", "origin", "-a"], repo);
    return (yield* read()) ?? "origin/main";
  });

/** The remote's default branch, e.g. `origin/main`, or undefined for a repository without a
 * remote. New branches start here rather than at a local main that may be days behind.
 *
 * Never fails: a timed-out `git` reads as "no default branch", and that tolerance is explicit
 * here rather than surfacing the timeout through every caller. */
export const remoteDefaultBranch = (
  repo: string,
): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    const known = defaultBranches.get(repo);
    if (known) return known;
    const asking = Effect.runSync(
      Effect.cached(
        askDefaultBranch(repo).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.tap((found) =>
            Effect.sync(() => {
              if (found === undefined) defaultBranches.delete(repo); // do not cache "no remote"
            }),
          ),
        ),
      ),
    );
    defaultBranches.set(repo, asking);
    return asking;
  });

/** The branch this repository's work starts from: what you chose, or the remote's default. */
export const baseFor = (
  change: Change,
  repo: string,
): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    const chosen = change.base?.[repo];
    return chosen !== undefined ? Effect.succeed(chosen) : remoteDefaultBranch(repo);
  });

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

const openMenu = (repo: string): { id: string; label: string; arg: string }[] =>
  openers
    .filter((o) => o.available?.() ?? true)
    .map(({ id, label }) => ({ id, label, arg: repo }));

/** Repositories worked on in place rather than through a worktree. */
export const isDirect = (change: Change, repo: string): boolean =>
  change.direct?.includes(repo) ?? false;

/** Where the change directory links to a repository used in place, so the change directory
 * still shows everything the change touches. */
const linkPath = (change: Change, repo: string): string => join(changeDir(change.id), basename(repo));

export const currentBranch = (repo: string): Effect.Effect<string> =>
  Effect.map(shSoft(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo), (r) => r.stdout);

export const isDirty = (repo: string): Effect.Effect<boolean> =>
  Effect.map(shSoft(["git", "status", "--porcelain"], repo), (r) => r.stdout !== "");

/**
 * Link a repository into the change directory so an idea can browse it, without touching the
 * checkout: no branch is switched and no worktree is registered, so nothing about the repository
 * changes. This is what the `change:created` hook does while a change is an idea; starting the
 * work replaces the link with a real checkout (worktree or in place).
 *
 * A path that is already there is the state this wanted: a link, or a checkout left by an earlier
 * start. A failure is logged and not fatal — the change is already written, and an idea whose
 * repository could not be linked is still an idea — but it is not swallowed, so a permission
 * problem does not read as success.
 */
export const browseRepo = (change: Change, repo: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const path = linkPath(change, repo);
    if (yield* fs(() => lstat(path).then(() => true, () => false))) return;
    yield* fs(() => symlink(repo, path)).pipe(
      Effect.catchAllDefect((e) =>
        Effect.sync(() =>
          console.error(`could not link ${repo} into ${changeDir(change.id)}:`, messageOf(e)),
        ),
      ),
    );
  });

/**
 * Work in the repository itself: link it from the change directory and put its checkout on the
 * change's branch, freshly branched off the remote default like a worktree would be.
 *
 * A repository with uncommitted work is linked but not touched otherwise: switching branches
 * under half-finished edits is the kind of help nobody wants. The widget then says so, and the
 * action can be repeated once the tree is clean.
 */
const useInPlace = (change: Change, repo: string): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    yield* browseRepo(change, repo);
    if ((yield* currentBranch(repo)) === change.branch) return;
    if (yield* isDirty(repo)) return; // reported by the widget; the user decides what to do
    const exists =
      (yield* shSoft(["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`], repo))
        .code === 0;
    if (exists) {
      yield* shOrThrow(["git", "switch", change.branch], repo);
      return;
    }
    const base = yield* baseFor(change, repo);
    if (base) yield* shSoft(["git", "fetch", "--quiet", "origin"], repo);
    // --no-track: branching off origin/main would otherwise make origin/main the upstream, and
    // the first `git push` would try to push your work straight onto it. The branch gets its own
    // upstream when it is first pushed, as a worktree's does.
    yield* shOrThrow(
      ["git", "switch", "--create", change.branch, ...(base ? ["--no-track", base] : [])],
      repo,
    );
  });

/** Remove a repository's link from the change directory — the browse link an idea carries, or
 * the in-place link a working change does. The repository's own checkout stays exactly as it is;
 * only Corvi's pointer to it goes. Used before replacing a browse link with a worktree, and when
 * stopping in-place work. */
export const unlinkRepo = (change: Change, repo: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const path = linkPath(change, repo);
    // Only a symlink is Corvi's link to remove. A real worktree directory at this path is not ours
    // to unlink — removing that is `removeWorktree`'s git command.
    const linked = yield* fs(() => lstat(path).then((s) => s.isSymbolicLink(), () => false));
    if (linked) yield* fs(() => unlink(path));
  });

/** How a repository used in place stands: which branch it is on, and whether it needs a hand. */
const directItem = (change: Change, repo: string): Effect.Effect<WidgetItem> =>
  Effect.gen(function* () {
    const label = basename(repo);
    const [branch, dirty] = yield* Effect.all([
      currentBranch(repo),
      isDirty(repo),
    ]);
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
    const entry = yield* entryFor(change, repo);
    const described = entry
      ? describe(entry)
      : {
        detail: dirty ? "uncommitted changes" : "clean",
        state: (dirty ? "pending" : "ok") as WidgetState,
      };
    return {
      label,
      detail: `in place · ${described.detail} · ${repo}`,
      state: described.state,
      menu: openMenu(repo),
    };
  });

/** Give this change its checkout in `repo`, by the mode the change asked for: a worktree, or
 * the repository's own checkout switched and linked, when the repo is worked on in place.
 * Whatever is already there is left alone. */
export const provisionRepo = (change: Change, repo: string): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (isDirect(change, repo)) return yield* useInPlace(change, repo);
    if (yield* checkoutFor(change, repo)) return;
    const exists =
      (yield* shSoft(["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`], repo))
        .code === 0;
    // --no-cd: we are not a shell, wt must not try to change directory on our behalf.
    if (exists) {
      yield* shOrThrow(yield* wt(change, ["-C", repo, "switch", change.branch, "--no-cd"]));
      return yield* carryTooling(repo, change);
    }
    // Branch from the chosen base, fetched first: a local main is often behind. The base is the
    // remote default unless this change is stacked on another one's branch.
    const base = yield* baseFor(change, repo);
    if (base) yield* shSoft(["git", "fetch", "--quiet", "origin"], repo);
    const baseArgs = base ? ["--base", base] : [];
    yield* shOrThrow(
      yield* wt(change, ["-C", repo, "switch", "--create", change.branch, ...baseArgs, "--no-cd"]),
    );
    yield* carryTooling(repo, change);
  });

/**
 * Give the new worktree the IDE and build-tool state the repository has, so opening it is
 * opening a configured project rather than importing one.
 *
 * Never fatal: the worktree is the thing that was asked for, and a change that failed to
 * provision over a copy of `.idea` would be a poor trade.
 */
const carryTooling = (repo: string, change: Change): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!config.worktreeCopy.length) return;
    const created = yield* checkoutFor(change, repo);
    if (!created) return;
    // The copy runs as an Effect too, so its `git check-ignore` carries the workspace env
    // (src/capabilities/os.ts); its failure is reported and never fatal.
    yield* copyTooling(repo, created, config.worktreeCopy).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => console.error(`could not copy IDE state into ${created}:`, error))),
    );
  });

/**
 * Give a repository its presence for the change's state: an idea is linked for browsing, a
 * started change gets its real checkout. The one place that decision is made, so creation, a
 * repository added later and the row's action cannot disagree about what a change is.
 */
export const provisionOrBrowse = (change: Change, repo: string): Effect.Effect<void, CliError> =>
  isIdeation(change) ? browseRepo(change, repo) : provisionRepo(change, repo);

/** Work a removal would throw away: uncommitted changes cannot be recovered at all, unpushed
 * commits survive in the reflog but not anywhere anyone else can see. */
export type Unsafe = { kind: "dirty" | "unpushed"; text: string };

/** wt's view of the branch against main: anything else means commits main does not have. */
const inMain = (state?: string): boolean =>
  ["is_main", "integrated", "empty", undefined].includes(state);

// Pure and synchronous: nothing for an Effect to wrap.
export function unsafeIn(entry: WtEntry | undefined): Unsafe | undefined {
  if (!entry) return undefined; // nothing to lose
  const tree = entry.working_tree ?? {};
  if (tree.staged || tree.modified || tree.untracked) {
    return { kind: "dirty", text: "uncommitted changes" };
  }
  // Commits ahead of the upstream, or commits on a branch that was never pushed at all. The
  // branch itself survives a removal while it is unmerged, but the worktree they were made in
  // does not, and nothing else points at them: worth a question before going ahead. Content
  // already in main is nothing to lose, pushed or not — the removal drops a copy, but only a
  // *proven* "integrated" counts. An unknown main_state (no origin remote, a failed lookup) is
  // not in main, so commits ahead of an upstream still warn.
  const ahead = entry.remote?.ahead ?? 0;
  if (ahead > 0) {
    return entry.main_state === "integrated"
      ? undefined
      : { kind: "unpushed", text: `${ahead} unpushed commit(s)` };
  }
  if (!entry.remote?.branch && !inMain(entry.main_state)) {
    return { kind: "unpushed", text: "commits that were never pushed" };
  }
  return undefined;
}

export const unsafeToRemove = (
  change: Change,
  repo: string,
): Effect.Effect<Unsafe | undefined> =>
  Effect.map(entryFor(change, repo), unsafeIn);

/** The repositories of a change, with what a removal would destroy: the edit dialog needs both. */
export const repoStates = (
  change: Change,
): Effect.Effect<
  { path: string; name: string; direct: boolean; base?: string; unsafe?: Unsafe }[]
> =>
  Effect.forEach(
    change.repos,
    (path) =>
      Effect.gen(function* () {
        return {
          path,
          name: basename(path),
          direct: isDirect(change, path),
          base: yield* baseFor(change, path),
          unsafe: yield* unsafeToRemove(change, path),
        };
      }),
    // Unbounded: the shared CLI semaphore caps how many of these run at once.
    { concurrency: "unbounded" },
  );

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
export type SetReposResult =
  | { _tag: "Done"; change: Change }
  | { _tag: "NeedsForce"; needsForce: string[] };

export const setRepos = (
  change: Change,
  repos: string[],
  force = false,
  direct?: string[],
  base?: Record<string, string>,
): Effect.Effect<SetReposResult, CliError | BadRequestError> =>
  Effect.gen(function* () {
    const wanted = [...new Set(repos.map((r) => r.trim()).filter(Boolean))];
    const wantedDirect = (direct ?? change.direct ?? []).filter((r) => wanted.includes(r));
    // A repository whose mode changed is torn down and set up again: the existing worktree or
    // link is as wrong as a repository that was dropped.
    const switched = wanted.filter((r) => isDirect(change, r) !== wantedDirect.includes(r));
    const removed = [...change.repos.filter((r) => !wanted.includes(r)), ...switched];
    const added = [...wanted.filter((r) => !change.repos.includes(r)), ...switched];

    const unsafe = yield* Effect.forEach(
      removed,
      (repo) => Effect.map(unsafeToRemove(change, repo), (unsafe) => ({ repo, unsafe })),
      // Unbounded: the shared CLI semaphore caps how many of these run at once.
      { concurrency: "unbounded" },
    );
    const dirty = unsafe.filter((u) => u.unsafe?.kind === "dirty");
    if (dirty.length) {
      return yield* new BadRequestError({
        message:
          `${dirty.map((d) => basename(d.repo)).join(", ")}: uncommitted changes, revert or commit them first`,
      });
    }
    const unpushed = unsafe.filter((u) => u.unsafe?.kind === "unpushed");
    if (unpushed.length && !force) {
      return { _tag: "NeedsForce", needsForce: unpushed.map((u) => basename(u.repo)) };
    }

    for (const repo of removed) yield* removeWorktree(change, repo);
    const bases = Object.fromEntries(
      Object.entries(base ?? change.base ?? {}).filter(([repo]) => wanted.includes(repo)),
    );
    const updated: Change = {
      ...change,
      repos: wanted,
      direct: wantedDirect.length ? wantedDirect : undefined,
      base: Object.keys(bases).length ? bases : undefined,
    };
    yield* writeChange(updated);
    for (const repo of added) yield* provisionOrBrowse(updated, repo);
    return { _tag: "Done", change: updated };
  });

/**
 * Drop the worktree. wt deletes the branch with it when it has been merged, and keeps it when it
 * has not — which is what makes switching a repository to in-place work: the worktree goes, the
 * branch stays, and the repository's own checkout picks it up.
 */
export const removeWorktree = (
  change: Change,
  repo: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (isDirect(change, repo)) return yield* unlinkRepo(change, repo);
    if (!(yield* checkoutFor(change, repo))) {
      // No worktree to remove — but an idea's repository still has a browse link to drop, or the
      // archived directory keeps a dangling symlink to it.
      return yield* unlinkRepo(change, repo);
    }
    yield* shOrThrow(
      yield* wt(change, ["-C", repo, "remove", "--yes", "--foreground", "--force", change.branch]),
    );
  });

/** The `git` integration's action runner, in Effect. */
export const gitRun = (
  change: Change,
  action: string,
  repo?: string,
): Effect.Effect<void, CliError | BadRequestError> =>
  Effect.gen(function* () {
    if (!repo) {
      return yield* new BadRequestError({ message: "repo required" });
    }
    if (action === "add") return yield* provisionOrBrowse(change, repo);

    // Opening: the worktree when there is one, the repository itself when it is used in place.
    const opener = openers.find((o) => o.id === action);
    if (opener) {
      const path = (yield* checkoutFor(change, repo)) ?? repo;
      yield* shOrThrow(opener.command(path));
      return;
    }

    // --foreground so the widget refresh that follows sees the removal; --force because build
    // artifacts are untracked files and this button was clicked deliberately.
    if (action === "remove") return yield* removeWorktree(change, repo);
    return yield* new BadRequestError({ message: `unknown git action: ${action}` });
  });
