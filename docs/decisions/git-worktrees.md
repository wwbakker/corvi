# Worktrees are git's

> **Kind:** decision · **Status:** accepted

## Context

Corvi shells out to the vendors' own CLIs rather than reimplementing them, and a worktree is git's
idea: `git worktree` has created, listed and removed them all along. Corvi nevertheless delegated
three operations to [`wt`](https://github.com/max-sixty/worktrunk) (Worktrunk): attach a branch's
worktree (`wt switch`), create a branch with its worktree (`wt switch --create`), and remove a
worktree with its branch (`wt remove`). Reading a worktree's state was already plain git —
`git worktree list --porcelain` and `git status --porcelain=v2`, because `wt list` cost seconds of
CPU per refresh — and wt itself creates ordinary git worktrees.

So wt was a dependency for two operations git does directly, plus one thing Corvi decided for
itself: where a change's worktrees live. That rule was expressed in wt's own configuration, a
per-change `wt.toml` (`worktree-path = "<change dir>/{{ repo }}"`): a file in every change
directory, a binary to install on every platform ([`wt-on-linux.md`](wt-on-linux.md), now
superseded), and a CI step — for a layout Corvi had written in the first place.

## Decision

**Git alone.** Creating, attaching and removing a worktree are `git worktree` calls, and the path is
Corvi's own layout, computed in one place (`worktreePath`, `src/vendors/git.ts`):
`<change dir>/<repository name>`.

- **Creating**: `git worktree add -b <branch> <path> <base>`. The base is the change's chosen base,
  or the repository's default branch: the remote's (`origin/HEAD`), or the repository's own `main`
  (then `master`) when there is no remote — which is what wt fell back to. With neither, git
  branches from `HEAD`.
- **`-c branch.autoSetupMerge=false` is part of the call.** `git worktree add -b` would otherwise
  make `origin/main` the new branch's upstream, and the first `git push` in that worktree would aim
  at main. wt never did that (it tracks a base only when the names match), and neither does Corvi.
- **Attaching**: `git worktree add <path> <branch>`. An existing branch is a cancelled change's,
  and attaching leaves it exactly as it was.
- **Removing**: `git worktree remove --force <path>`, and then the branch — deleted only when Corvi
  can prove it has nothing left to contribute to the repository's default branch. Three proofs, any
  one of which is enough: nothing beyond the default branch (`git rev-list --count`), every commit
  patch-identical to one already there (`git cherry`), or a simulated merge that lands on the
  default branch's own tree (`git merge-tree --write-tree` — the multi-commit squash merge, which
  is what `gh pr merge --squash` leaves). Anything else, including a simulated merge that
  conflicts, is "not proven", and doubt keeps the branch.

The card's own reading of a branch (`main_state`, "merged"/"diverged") keeps the cheap proofs
only: it is painted on every dashboard refresh, and the simulated merge writes objects into the
repository, which is not something a read path should do. Everything that *acts* — the removal,
and the question a removal asks first — goes through the full predicate, whose merge is cached on
the pair of tip SHAs it depends on (objects are content-addressed, so the answer is a property of
two commits; a ref that moved is a different pair, and misses). A card can therefore still say
"diverged" for a squash-merged branch that the removal will in fact delete, but nobody is asked to
acknowledge work that is already in main: the asymmetry that remains is a cautious label, never a
deletion that guesses.

## What was given up

- **A repository's own wt hooks** (a project `.config/wt.toml` with `post-create` and friends) no
  longer run when Corvi creates a worktree. Corvi never configured any, and copies IDE state itself
  (`worktreeCopy`), but a repository that relied on them loses that. Running them would mean
  invoking wt again, which is the dependency this removes.
- **wt's last merge check** — matching a branch's whole diff, patch-id and all, against a single
  squash-merge commit when the simulated merge conflicts — is not reimplemented. Its absence only
  ever keeps a branch.
- **`wt.toml` in existing change directories** is an ordinary leftover now: nothing writes it, and
  nothing reserves its name. Worktrees made when wt owned the path are at exactly the path Corvi
  computes, so no change was migrated.

## Consequences

- Corvi needs `git`, `gh`, `az` and `tmux`; CI installs no worktree tool, and a checkout without
  `wt` runs the whole suite.
- A missing tool no longer has its own failure mode: a worktree failure is git's own error,
  rendered through the same `CliError` path as every other CLI.
- A repository without a remote still has a default branch for Corvi's purposes (`main`, then
  `master`), so branch shape, the card's "merged" reading and the loose-end report do not depend on
  whether a remote exists.
