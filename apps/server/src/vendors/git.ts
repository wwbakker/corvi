import { basename, join } from "node:path";
import { symlink, lstat, unlink } from "node:fs/promises";
import { Effect } from "effect";
import type { Change, CheckoutSpec } from "../domain/change.ts";
import {
  checkoutSpecProblem,
  duplicateRepoNames,
  effectiveBranchOf,
  isIdeation,
  specFor,
  targetOf,
} from "../domain/change.ts";
import type { Widget, WidgetItem, WidgetState } from "../domain/widget.ts";
import { shOrThrow } from "../capabilities/shell.ts";
import { runtimeConfig } from "../workspace/server/index.ts";
import { copyTooling } from "../capabilities/os.ts";
import { writeChange, changeDir } from "../change/server/store.ts";
import { isMac, commandAvailable } from "../capabilities/os.ts";
import { BadRequestError, type CliError } from "@corvi/contracts/errors";
import type { ChangeFormatTooNew } from "@corvi/changes/errors";
import { fs, messageOf, shSoft } from "../capabilities/effect/support.ts";

/**
 * One worktree, as the dashboard reads it.
 *
 * Read with plain git: `git worktree list --porcelain` and `git status --porcelain=v2` cost ~25ms
 * together, and the dashboard asks once per repository per refresh. Corvi creates and removes the
 * worktrees itself (`worktreePath`, `provisionRepo`, `removeWorktree`) — this only reads what is
 * there.
 */
export type WorktreeEntry = {
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

/** Where this change's worktree for `repo` lives: inside the change directory, beside the rest of
 * the change's own state, named after the repository so the directory reads as the change's.
 *
 * Corvi's layout, not git's: `git worktree add` takes the path it is given, and the path is
 * computed here so every caller — provisioning, removal, the card — agrees on one answer.
 * Worktrees created before Corvi owned the path (when wt's `worktree-path` config wrote it) are at
 * exactly this path, so nothing needs migrating. */
export const worktreePath = (change: Change, repo: string): string =>
  join(changeDir(change.id), basename(repo));

// Pure and synchronous: nothing for an Effect to wrap.
export const findWorktree = (entries: WorktreeEntry[], branch: string): WorktreeEntry | undefined =>
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
export function parseStatus(status: string): NonNullable<WorktreeEntry["working_tree"]> & {
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

/** Whether `branch` adds nothing to `base`, by the cheap proofs: `base` contains it outright, or
 * contains patch-identical copies of every commit — what a rebase, a cherry-pick or a one-commit
 * squash merge leaves behind, whose commits are never ancestors of `base`.
 *
 * `undefined` is "not proven either way": a base that does not resolve, or a count that cannot be
 * read. The card shows that as unknown rather than diverged, which is the honest label, and every
 * reader that acts on it treats it as not integrated. Local refs only, so callers that need the
 * truth fetch first; routed through `sh` like the rest, so a test scripts it like any other
 * command. */
const cheaplyIntegrated = (
  repo: string,
  branch: string,
  base: string,
): Effect.Effect<boolean | undefined> =>
  Effect.gen(function* () {
    // Nothing beyond the base: the branch is contained outright, no cherry needed. An empty or
    // unparseable count is "not proven", not zero — `Number("")` is 0, which would read
    // every failed lookup as merged.
    const raw = (yield* shSoft(["git", "rev-list", "--count", `${base}..${branch}`], repo)).stdout.trim();
    if (!/^\d+$/.test(raw)) return undefined;
    if (Number(raw) === 0) return true;
    return yield* cherryInMain(repo, branch, base);
  });

/** Whether `branch` adds nothing to `base`, by the cheap proofs alone. For the callers that ask
 * often and cannot pay for a merge: the readiness poll, and the card's own reading (`entryFor`). */
export const contentInMain = (
  repo: string,
  branch: string,
  base: string | undefined,
): Effect.Effect<boolean> =>
  base
    ? Effect.map(cheaplyIntegrated(repo, branch, base), (proof) => proof === true)
    : Effect.succeed(false);

/** Whether a simulated merge of `base` and `branch` lands on the tree `base` already has: the
 * branch's changes are already in `base`'s content. This is the multi-commit squash merge —
 * `gh pr merge --squash` on a branch with more than one commit — where no single commit's patch-id
 * matches and the ancestry is theirs, not main's.
 *
 * A conflict exits non-zero and is "not proven", not an error: doubt keeps a branch, it never
 * deletes one. `--write-tree` writes the merged tree into the object database; nothing points at it
 * and `git gc` reclaims it — the price of asking the question wt asked. */
const mergeAddsNothing = (
  repo: string,
  branch: string,
  base: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const merged = yield* shSoft(["git", "merge-tree", "--write-tree", base, branch], repo);
    if (merged.code !== 0) return false;
    const tree = merged.stdout.split("\n")[0]?.trim();
    const target = (yield* shSoft(["git", "rev-parse", `${base}^{tree}`], repo)).stdout.trim();
    return Boolean(tree && target && tree === target);
  });

/** The simulated merge is the only expensive half of `integrated`, and its answer is a property of
 * two commits: objects are content-addressed, so a pair of tip SHAs determines it, and a ref that
 * has moved (a fetch, a commit) is a different pair. One entry per repository and branch — the
 * tips it was computed for, and what they answered — so the map is bounded by the branches the
 * dashboard asks about rather than by commits, and no entry ever needs invalidating. */
const integratedCache = new Map<string, { base: string; branch: string; answer: boolean }>();

/** The tips `base` and `branch` point at now, or undefined when one of them does not resolve — and
 * then the answer is simply not cached. */
const tipPair = (
  repo: string,
  base: string,
  branch: string,
): Effect.Effect<{ base: string; branch: string } | undefined> =>
  Effect.map(shSoft(["git", "rev-parse", base, branch], repo), (r) => {
    const [baseSha, branchSha] = r.stdout.split("\n").map((line) => line.trim());
    return r.code === 0 && baseSha && branchSha ? { base: baseSha, branch: branchSha } : undefined;
  });

/** Whether `branch` adds nothing to `base` — the one answer everything that acts on a branch should
 * agree on. The cheap proofs first (most branches are settled by them, for the price of two git
 * reads), then a simulated merge for the squash merges they cannot see, cached on the pair of tip
 * SHAs it depends on.
 *
 * The merge is asked only where the answer decides something: a removal, and whether a removal has
 * to ask about commits nobody else has. The card's label stays on the cheap half (`contentInMain`),
 * because it is painted on every refresh and a merge writes into the repository; the disagreement
 * that leaves is a label that is cautious, never a deletion that guesses. */
export const integrated = (
  repo: string,
  branch: string,
  base: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const cheap = yield* cheaplyIntegrated(repo, branch, base);
    if (cheap === true) return true;
    const key = `${repo}\0${branch}`;
    const tips = yield* tipPair(repo, base, branch);
    const known = integratedCache.get(key);
    if (tips && known && known.base === tips.base && known.branch === tips.branch) {
      return known.answer;
    }
    const answer = yield* mergeAddsNothing(repo, branch, base);
    if (tips) integratedCache.set(key, { base: tips.base, branch: tips.branch, answer });
    return answer;
  });

/** The branch this change's checkout of `repo` is on: the change's own, the existing branch the
 * spec named, or — adopted as it is — whatever the checkout has checked out now. */
export const branchNameOf = (
  change: Change,
  repo: string,
  spec: CheckoutSpec | undefined = specFor(change, repo),
): Effect.Effect<string | undefined> => {
  const effective = effectiveBranchOf(change.branch, spec?.branch ?? { kind: "change" });
  return effective._tag === "Recorded" ? Effect.succeed(effective.name) : currentBranch(repo);
};

/** The worktree holding this change's branch in `repo`, with everything the dashboard says
 * about it. Undefined when the change has no worktree there. */
export const entryFor = (change: Change, repo: string): Effect.Effect<WorktreeEntry | undefined> =>
  Effect.gen(function* () {
    const worktrees = parseWorktrees(
      (yield* shSoft(["git", "worktree", "list", "--porcelain"], repo)).stdout,
    );
    const branch = yield* branchNameOf(change, repo);
    const found = branch ? worktrees.find((w) => w.branch === branch) : undefined;
    if (!found) return undefined;

    const [status, base] = yield* Effect.all([
      shSoft(["git", "status", "--porcelain=v2", "--branch"], found.path),
      defaultBranch(repo),
    ]);
    const tree = parseStatus(status.stdout);
    // Whether the default branch already has everything on this branch, which is how a merged
    // change is spotted — the cheap proofs only, because this is painted on every refresh and the
    // simulated merge that catches a squash (`integrated`) writes into the repository. A lookup
    // that cannot be read is unknown rather than diverged, and the card says so.
    const proven = base ? yield* cheaplyIntegrated(repo, found.branch, base) : undefined;
    return {
      branch: found.branch,
      path: found.path,
      working_tree: { staged: tree.staged, modified: tree.modified, untracked: tree.untracked },
      remote: tree.upstream
        ? { branch: tree.upstream, ahead: tree.ahead, behind: tree.behind }
        : null,
      // "diverged" for commits the default branch does not have, which is what makes them worth
      // warning about before a removal. Unknown — no default branch to compare with, or a failed
      // lookup — stays undefined, and every reader treats that as "not in main". Patch-identical
      // content counts as integrated: a squash merge lands the content without the ancestry.
      main_state: proven === undefined ? undefined : proven ? "integrated" : "diverged",
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
export function describe(entry: WorktreeEntry): { detail: string; state: WidgetState } {
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
    // exists, so the row says that instead of offering to create one. Checked before the spec,
    // since which way the work will use it is a decision for the start, not for the idea.
    if (isIdeation(change)) {
      return {
        label: basename(repo),
        detail: `linked for browsing · ${repo}`,
        state: "none",
        menu: openMenu(repo),
      };
    }
    const spec = specFor(change, repo);
    if (spec?.location === "original") return yield* inPlaceItem(change, repo, spec);
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
 * remote. New branches start here rather than at a local main that may be days behind, and this
 * is the remote-only half of `defaultBranch`; GitHub's pull-request base reads it directly and
 * should keep seeing `origin/…` or nothing.
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

/** The repository's own default branch, for one without a remote: `main`, then `master` — what
 * `wt switch` fell back to, and the branch a worktree should grow out of just the same. It has
 * its own memo so `remoteDefaultBranch` keeps its remote-only meaning, and "neither" is not
 * cached: the branch can be created later. */
const localDefaultBranches = new Map<string, Effect.Effect<string | undefined>>();

const askLocalDefaultBranch = (repo: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    for (const name of ["main", "master"]) {
      const found = yield* shSoft(
        ["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`],
        repo,
      );
      if (found.code === 0) return name;
    }
    return undefined;
  });

const localDefaultBranch = (repo: string): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    const known = localDefaultBranches.get(repo);
    if (known) return known;
    const asking = Effect.runSync(
      Effect.cached(
        askLocalDefaultBranch(repo).pipe(
          Effect.tap((found) =>
            Effect.sync(() => {
              if (found === undefined) localDefaultBranches.delete(repo); // do not cache "neither"
            }),
          ),
        ),
      ),
    );
    localDefaultBranches.set(repo, asking);
    return asking;
  });

/** The branch this repository's work starts from and is measured against: the remote's default
 * (`origin/main`), or — a repository with no remote — its own `main`/`master`. Undefined only when
 * there is neither, and then nothing is measured and nothing is assumed to be merged. */
export const defaultBranch = (repo: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const remote = yield* remoteDefaultBranch(repo);
    return remote ?? (yield* localDefaultBranch(repo));
  });

/** The branch this repository's work starts from: what the change chose for it, or the
 * repository's default branch — the remote's, or its own main/master when there is no remote. */
export const baseFor = (
  change: Change,
  repo: string,
): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    const chosen = specFor(change, repo)?.base;
    return chosen !== undefined ? Effect.succeed(chosen) : defaultBranch(repo);
  });

/** What a pull request merges into: the spec's `target`, else the `base` its branch started
 * from — one field served both roles before they were split, so a spec without `target` still
 * means it — else the repository's default branch. */
export const targetFor = (
  change: Change,
  repo: string,
): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    const spec = specFor(change, repo);
    const chosen = spec ? targetOf(spec) : undefined;
    return chosen !== undefined ? Effect.succeed(chosen) : defaultBranch(repo);
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

/** Whether this change's checkout of `repo` is the repository's own, rather than a worktree. */
export const isInPlace = (change: Change, repo: string): boolean =>
  specFor(change, repo)?.location === "original";

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
 * branch the spec asks for — the change's own, freshly branched off the remote default like a
 * worktree would be, or an existing branch, only ever switched to.
 *
 * A repository with uncommitted work is linked but not touched otherwise: switching branches
 * under half-finished edits is the kind of help nobody wants. The widget then says so, and the
 * action can be repeated once the tree is clean.
 */
const useInPlace = (change: Change, repo: string, spec: CheckoutSpec): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    yield* browseRepo(change, repo);
    const wanted = spec.branch.kind === "existing" ? spec.branch.name : change.branch;
    if ((yield* currentBranch(repo)) === wanted) return;
    if (yield* isDirty(repo)) return; // reported by the widget; the user decides what to do
    if (spec.branch.kind === "existing") {
      // An existing branch is only ever attached: `git switch` tracks a remote-only name and
      // refuses a name that is nowhere.
      yield* shOrThrow(["git", "switch", wanted], repo);
      return;
    }
    const exists =
      (yield* shSoft(["git", "show-ref", "--verify", "--quiet", `refs/heads/${wanted}`], repo))
        .code === 0;
    if (exists) {
      yield* shOrThrow(["git", "switch", wanted], repo);
      return;
    }
    const base = yield* baseFor(change, repo);
    // Only a remote has something to fetch; a repository with no remote branches from its own
    // default branch, which is already local.
    if (yield* remoteDefaultBranch(repo)) yield* shSoft(["git", "fetch", "--quiet", "origin"], repo);
    // --no-track: branching off origin/main would otherwise make origin/main the upstream, and
    // the first `git push` would try to push your work straight onto it. The branch gets its own
    // upstream when it is first pushed, as a worktree's does.
    yield* shOrThrow(
      ["git", "switch", "--create", wanted, ...(base ? ["--no-track", base] : [])],
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
/** How a repository used where it stands is going, by the branch question it was given: the
 * change's branch (and a nudge when the checkout drifted off it), a named existing branch
 * (drift is reported, never repaired), or the checkout's own current branch (nothing to say). */
const inPlaceItem = (change: Change, repo: string, spec: CheckoutSpec): Effect.Effect<WidgetItem> =>
  Effect.gen(function* () {
    const label = basename(repo);
    const [branch, dirty] = yield* Effect.all([
      currentBranch(repo),
      isDirty(repo),
    ]);
    if (spec.branch.kind === "change" && branch !== change.branch) {
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
    if (spec.branch.kind === "existing" && branch !== spec.branch.name) {
      return {
        label,
        detail: dirty
          ? `in place, on ${branch} with uncommitted changes — not ${spec.branch.name}`
          : `in place, on ${branch} — not ${spec.branch.name}`,
        detailTone: "warn",
        state: "warn",
        menu: openMenu(repo),
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
    const way = spec.branch.kind === "current" ? "current branch" : "in place";
    return {
      label,
      detail: `${way} · ${described.detail} · ${repo}`,
      state: described.state,
      menu: openMenu(repo),
    };
  });

/** Give this change its checkout in `repo`, by the way its spec asks for it: a worktree on a
 * created or an attached branch, the repository's own checkout switched and linked, or the
 * checkout adopted as it is — a link and nothing else. Whatever is already there is left alone. */
export const provisionRepo = (change: Change, repo: string): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const spec = specFor(change, repo);
    if (!spec) return;
    // Adopting the checkout's current branch is the link and no checkout work at all.
    if (spec.branch.kind === "current") return yield* browseRepo(change, repo);
    if (spec.location === "original") return yield* useInPlace(change, repo, spec);
    if (yield* checkoutFor(change, repo)) return;
    const wanted = spec.branch.kind === "existing" ? spec.branch.name : change.branch;
    const exists =
      (yield* shSoft(["git", "show-ref", "--verify", "--quiet", `refs/heads/${wanted}`], repo))
        .code === 0;
    const path = worktreePath(change, repo);
    // The branch is already there — a cancelled change keeps an unmerged one, and re-creating the
    // change is how you get back to it. Attaching leaves its configuration alone. An existing
    // branch is only ever attached: `git worktree add` tracks a remote-only name and refuses a
    // name that is nowhere.
    if (exists || spec.branch.kind === "existing") {
      yield* shOrThrow(["git", "worktree", "add", path, wanted], repo);
      return yield* carryTooling(repo, change);
    }
    // Branch from the chosen base, fetched first: a local main is often behind. The base is the
    // remote default unless this change is stacked on another one's branch; a repository with no
    // remote falls back to its own default branch.
    const base = yield* baseFor(change, repo);
    if (yield* remoteDefaultBranch(repo)) yield* shSoft(["git", "fetch", "--quiet", "origin"], repo);
    // -c branch.autoSetupMerge=false: branching off origin/main would otherwise make origin/main
    // the upstream, and the first `git push` would try to push your work straight onto it. The
    // branch gets its own upstream when it is first pushed, as before. With no base at all (no
    // remote, and no main or master), git branches from HEAD.
    yield* shOrThrow(
      [
        "git",
        "-c",
        "branch.autoSetupMerge=false",
        "worktree",
        "add",
        "-b",
        change.branch,
        path,
        ...(base ? [base] : []),
      ],
      repo,
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
    if (!runtimeConfig().worktreeCopy.length) return;
    const created = yield* checkoutFor(change, repo);
    if (!created) return;
    // The copy runs as an Effect too, so its `git check-ignore` carries the workspace env
    // (apps/server/src/capabilities/os.ts); its failure is reported and never fatal.
    yield* copyTooling(repo, created, runtimeConfig().worktreeCopy).pipe(
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

/** Whether the branch holds nothing the default branch lacks. Everything else — "diverged", and
 * `undefined` for a branch whose state could not be read — means commits are there to lose. */
const inMain = (state?: string): boolean => state === "integrated";

// Pure and synchronous: nothing for an Effect to wrap.
export function unsafeIn(entry: WorktreeEntry | undefined): Unsafe | undefined {
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
  Effect.gen(function* () {
    const entry = yield* entryFor(change, repo);
    const unsafe = unsafeIn(entry);
    // Commits nobody else has is the warning that content in the default branch withdraws. Ask the
    // simulated merge before asking the user: a squash merge leaves commits no cheap check can
    // prove landed, and being made to acknowledge work that is already in main is noise.
    if (unsafe?.kind !== "unpushed") return unsafe;
    const base = yield* defaultBranch(repo);
    const branch = yield* branchNameOf(change, repo);
    if (base && branch && (yield* integrated(repo, branch, base))) return undefined;
    return unsafe;
  });

/** The repositories of a change, with what a removal would destroy: the edit dialog needs both. */
export const repoStates = (
  change: Change,
): Effect.Effect<(CheckoutSpec & { name: string; unsafe?: Unsafe })[]> =>
  Effect.forEach(
    change.checkouts ?? [],
    (spec) =>
      Effect.gen(function* () {
        return {
          ...spec,
          name: basename(spec.path),
          unsafe: yield* unsafeToRemove(change, spec.path),
        };
      }),
    // Unbounded: the shared CLI semaphore caps how many of these run at once.
    { concurrency: "unbounded" },
  );

/**
 * Apply a new checkout list in one go: everything added gets its checkout, everything dropped
 * loses one. Nothing is destroyed without a word: uncommitted work in a worktree that would be
 * removed is the one refusal — that work would be lost — and every other removal is a question
 * the caller confirms or abandons.
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

// Pure and synchronous: nothing for an Effect to wrap.
const sameSpec = (a: CheckoutSpec, b: CheckoutSpec): boolean =>
  a.path === b.path &&
  a.location === b.location &&
  a.branch.kind === b.branch.kind &&
  (a.branch.kind === "existing" && b.branch.kind === "existing"
    ? a.branch.name === b.branch.name
    : true) &&
  (a.base ?? "") === (b.base ?? "") &&
  (a.target ?? "") === (b.target ?? "");

export const setRepos = (
  change: Change,
  specs: CheckoutSpec[],
  force = false,
): Effect.Effect<SetReposResult, CliError | BadRequestError | ChangeFormatTooNew> =>
  Effect.gen(function* () {
    // Whitespace is nothing, and the same path twice is a double click rather than two
    // repositories: the first mention wins.
    const wanted = [
      ...new Map(
        specs
          .map((spec) => ({ ...spec, path: spec.path.trim() }))
          .map((spec) => [spec.path, spec] as const),
      ).values(),
    ].filter((spec) => spec.path);
    for (const spec of wanted) {
      const problem = checkoutSpecProblem(spec);
      if (problem) return yield* new BadRequestError({ message: problem });
    }
    // Every repository is filed in the change directory under its own name, so two paths with the
    // same name would collide there — a worktree on top of a worktree, or two browse links.
    const duplicate = duplicateRepoNames(wanted.map((spec) => spec.path));
    if (duplicate.length) {
      return yield* new BadRequestError({
        message:
          `two repositories share the name ${duplicate.join(", ")}: Corvi files each repository ` +
          `under its own name in the change directory`,
      });
    }
    const current = change.checkouts ?? [];
    const wantedByPath = new Map(wanted.map((spec) => [spec.path, spec]));
    const currentByPath = new Map(current.map((spec) => [spec.path, spec]));
    // A row whose spec changed is set up again the new way, and whatever it leaves is torn
    // down: the existing worktree or checkout is as wrong as a repository that was dropped.
    const teardown = current.filter((spec) => {
      const next = wantedByPath.get(spec.path);
      return next === undefined || !sameSpec(spec, next);
    });
    const setup = wanted.filter((spec) => {
      const prior = currentByPath.get(spec.path);
      return prior === undefined || !sameSpec(prior, spec);
    });

    // What leaving behind is worth asking about. A worktree goes, its branch stays unless its
    // work is proven landed; a checkout used where it is is left exactly as it stands. So the
    // question is the same for both — the only refusal is destroying uncommitted work.
    const questions: string[] = [];
    const lost: string[] = [];
    for (const spec of teardown) {
      const unsafe = yield* unsafeToRemove(change, spec.path);
      if (!unsafe) continue;
      if (unsafe.kind === "dirty" && spec.location === "new") lost.push(basename(spec.path));
      else questions.push(basename(spec.path));
    }
    if (lost.length) {
      return yield* new BadRequestError({
        message: `${lost.join(", ")}: uncommitted changes, revert or commit them first`,
      });
    }
    if (questions.length && !force) {
      return { _tag: "NeedsForce", needsForce: questions } satisfies SetReposResult;
    }

    for (const spec of teardown) yield* removeWorktree(change, spec.path);
    const updated: Change = { ...change, checkouts: wanted };
    yield* writeChange(updated);
    for (const spec of setup) yield* provisionOrBrowse(updated, spec.path);
    return { _tag: "Done", change: updated } satisfies SetReposResult;
  });

/**
 * Drop a checkout. A worktree goes, and its branch with it when the branch adds nothing to the
 * repository's default branch; a checkout used where it is loses only the change directory's
 * link — the repository, its checkout and its branches are the user's. Deleting a branch is the
 * destructive half, so it is asked separately: only a branch Corvi created for this work whose
 * content is provably already in the default branch goes, and every other branch is kept.
 *
 * Keeping a branch is what makes switching a repository to in place work: the worktree goes, the
 * branch stays, and the repository's own checkout picks it up. A branch that could not be
 * deleted is not an error — the worktree is gone, and the caller reports what is left (cancel's
 * "the branch X is kept in …") rather than failing a removal that happened.
 */
export const removeWorktree = (
  change: Change,
  repo: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const spec = specFor(change, repo);
    if (spec?.location === "original") return yield* unlinkRepo(change, repo);
    const path = yield* checkoutFor(change, repo);
    if (!path) {
      // No worktree to remove — but an idea's repository still has a browse link to drop, or the
      // archived directory keeps a dangling symlink to it.
      return yield* unlinkRepo(change, repo);
    }
    // --force because build artifacts are untracked files and this was asked for deliberately; it
    // also succeeds for a worktree whose directory was deleted by hand, which git still has
    // registered until something prunes it.
    yield* shOrThrow(["git", "worktree", "remove", "--force", path], repo);
    // Only a branch Corvi created is deleted; a borrowed one — an existing branch by name — is
    // the user's and stays.
    if (spec?.branch.kind !== "change") return;
    const base = yield* defaultBranch(repo);
    // -D, not -d: the merge that landed this content may have been a squash, so git's own
    // ancestry test refuses what `integrated` has just proven. Proven first, or the branch stays.
    if (base && (yield* integrated(repo, change.branch, base))) {
      yield* shSoft(["git", "branch", "-D", change.branch], repo);
    }
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
