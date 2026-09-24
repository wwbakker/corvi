# Changes

![A change's dashboard](../images/change.png)

A change groups work across repositories, associated tickets/pull requests, documents, and
terminals. Active changes live under `~/corvi/changes/<id>/`; finished records move to the
configured archive.

## Creating an idea

**New** opens the wizard: one screen, the plan on the left and everything else down the right.
The left half is `PLAN.md`'s starting text in the Markdown editor, seeded from the `planTemplate`
setting (see [configuration](configuration.md)). The change's name is the plan's first `#`
heading — the title follows it as you write, one-way, and the id and branch follow the title
until you edit either by hand.

The right half holds the sections. Each enabled issue integration is collapsed to its pick: Jira
tickets and GitHub issues alike are a single field with an **Edit…** that opens the board or the
issue list in a dialog, where you can select or create an issue (the GitHub field shows the
issue's number under its repository). Picking an issue names the change too — by writing the
plan's heading — while that heading is still the template's; your own words are never rewritten.
Both issue integrations can be used together. Below them: the workspace, the change id and
branch, and the repositories as a small list of what is picked, with the same kind of edit
button over the directory browser. Repositories are optional for an idea; the browser starts at
`repositoriesDirectory` and can navigate up to `/`.

Leaving the wizard preserves one draft in the page. It appears under **Ideas** as *New idea* or
its title. Reopening restores the fields and selections. **Discard** removes it; closing/reloading
the application forgets it. No server-side change exists until **Create idea**.

Creating an idea writes its record and `PLAN.md`, and opens the change on its plan. Selected
repositories are linked for browsing; no branch/worktree is created and no ticket moves. The
**Plan** tab edits the same file an agent can read. **Brief the agent** pastes the configured
briefing into the change's terminal.

**Start work** is the transition out of `Ideation`: it moves the state to `Implementation`,
prepares the selected checkouts, and moves associated tickets. Partial provisioning failures are
reported on the existing change so they can be addressed rather than losing the record.

## Repositories and checkouts

Each repository's checkout answers two questions independently: where the checkout lives, and
which branch it uses.

Where it lives:

- **New worktree:** a separate checkout in the change directory. The source repository keeps its
  own checkout, and Corvi owns the worktree: completing or cancelling the change removes it.
- **In place:** the repository's own checkout, linked into the change directory for reading.
  Corvi never removes it; only the link goes.

Which branch it uses:

- **New branch:** the change's branch — created where the repository's `base` branch left off
  when it does not exist yet, attached when it does.
- **Current branch:** whatever the checkout has checked out now, untouched. Nothing is created,
  switched or fetched; the change follows the checkout, and its branch is read live wherever it
  matters. Only possible in place: a branch already checked out somewhere cannot also live in a
  worktree.
- **Existing branch:** a branch you name. It is only ever attached — a remote-only name gets a
  local branch tracking it — and never created. In a worktree it is checked out there; in place
  the repository's checkout switches to it (a dirty checkout is left alone and reported).

Two branch questions per repository, split on purpose:

- **Starts from** (`base`) — where a new branch grows out of. Offered for *New branch* only.
- **Merges into** (`target`) — what a pull request targets. Offered for every row; another
  change's branch makes a stacked pull request. Unset means the repository's default. A record
  written before the split has one field serving both, and keeps meaning both.

Repositories without a remote can still use local branches. Creating a worktree must not make
the remote default branch the new branch's push upstream.

The Local changes card's repository editor applies additions/removals together when confirmed.
Cancelling the editor changes nothing. An existing change's list may be emptied and repopulated.
Repositories with the same directory basename cannot share a change directory.

Removal safety is enforced on the server:

- Removing a worktree with uncommitted work refuses outright, even with force: that work would
  be lost.
- Anything else that leaves work behind — a worktree with unpushed commits, a checkout used in
  place with uncommitted or unpushed work — asks first and goes ahead when confirmed. A checkout
  used in place is left exactly as it stands: only the link goes.
- Unpushed commits require acknowledgement; the branch remains unless its contents are proven
  integrated into the default branch. Only a branch Corvi created for a worktree is ever deleted;
  an existing branch you named is yours and stays.
- A failed integration proof keeps the branch. A cautious display label is not proof for deletion.

### What a new worktree inherits

The `worktreeCopy` setting defaults to:

```text
.idea  .bsp  .bloop  .scala-build  .metals  .vscode
```

Only directories ignored by the destination worktree are copied. Paths inside copied files are
rewritten to the destination without replacing unrelated path prefixes. Existing destination
settings are left alone. Build outputs such as `target` and `node_modules` are not copied, and a
copy failure does not make worktree creation fail.

## Dashboard and review

The dashboard shows the notes beside independently loaded integration status cards: local
worktrees, Jira, GitHub pull requests/checks, and Azure pipeline runs where enabled.
Narrow windows stack documents before status cards.

A card that owns something editable carries a pencil in its header, the same way the Local
changes card's repository editor does. The Jira and GitHub issues cards re-point their change at
another issue through it: the board or issue list again, and what the change's completion later
moves or closes follows the new link. The old ticket is left where it is. A finished change is a
record — its cards carry no pencil, and its links are read-only.

The **Plan** tab holds the change's own document, between the dashboard and the tabs extensions
contribute: `PLAN.md` as Markdown source, in the same editor the notes are written in. The text
follows the file when it changes outside Corvi — an agent or an IDE editing it — and when edits
are in flight it asks, with **Reload** and **Keep mine**, before either version goes away. A
finished change's plan is a read-only record.

The **Review changes** tab shows per-repository staged/unstaged changes and diffs. Its commit and
push actions are described in [integrations and included features](integrations.md#review-changes).
Repository menus can open the relevant checkout in the file manager or IntelliJ when available.

## Names, state, and ordering

The active lifecycle states are:

```text
Ideation
Implementation
Verification
Blocked
```

Ideas are grouped separately; active work is ordered by state and then newest first. Finished
changes are listed separately as `Completed` or `Cancelled` and remain readable.

State is chosen by the user rather than derived from ticket or pull-request status. `Ideation`
is entered on creation and left through **Start work**, not the ordinary state selector.
A record without a state is treated as `Implementation`.

A change's title can come from its associated issue. Provider failures leave the last stored title
intact. Renaming through the change's Actions menu makes the title user-owned; clearing the edit
allows automatic naming again. Archived records retain their names.

## The change record

`change.json` holds the change's name, state, and one checkout spec per repository — where its
checkout lives, which branch it uses, and what that branch starts from and merges into (see
[Repositories and checkouts](#repositories-and-checkouts)). The record carries the format's
version in `formatVersion`.

Corvi upgrades the record in place: a record from before the format version is converted on its
next read, and one written by a newer Corvi is opened read-only — every write is refused with an
explanation, so a newer format is never flattened into an older one. Upgrade Corvi before editing
a change a newer version has written.

## Completing a change

**Complete change** evaluates readiness against fresh relevant state. A blocked operation explains
its reasons. Forceable reasons can be acknowledged individually; uncommitted work and an idea
cannot be overridden.

Normal completion merges eligible outstanding pull requests, performs required issue/completion
steps, removes worktrees safely, closes the change's terminal, and archives the record and documents.
Merges run sequentially: if one fails, later merges have not happened. A provider step failure stops
completion and is visible in the progress record.

Current GitHub behavior uses squash merging. Required reviews and requested changes block ordinary
completion; no review decision does not itself mean a required review is missing. Stack merging
uses the asynchronous provider operation and reports a queued result when it has not landed yet.
A branch proven integrated can count as merged without a pull request, unless an open pull request
still asserts it is under review.

Completing with acknowledged overrides can leave unmerged pull requests open and unpushed commits
on their branches. The overridden reasons are recorded and shown. Cancellation is a different
operation; use it when abandoning rather than completing work.

Progress is stored in `completion.json`: steps, running/done/failed status, details, and timestamps.
It remains visible after a restart or from another page. **Try again** reassesses what remains,
including merges already completed; do not assume that arbitrary external operations are exactly-once.
The progress card remains available after successful completion.

Finished changes retain their dashboard without mutation actions. The server also rejects actions
that would revive an archived checkout. Browsing a finished change does not start a terminal.

## Cancelling a change

**Cancel change** removes local worktrees/links, closes the terminal, and archives the change as
`Cancelled`. It does not close pull requests or move tickets. The result lists what remains open.

The same removal protections apply: dirty work blocks cancellation; unpushed work requires
acknowledgement and remains recoverable on a retained branch. Branch retention is reported from
the actual removal result, not assumed before checking.

## Left behind

The **Left behind** page lists directories in the changes roots that no longer contain a change
record. They may hold build output or scratch files. Nothing is deleted automatically.

Deletion refuses a directory that still has `change.json` and leaves the archived copy alone.
Repositories and registered worktrees are identified in the confirmation; removed worktrees are
pruned from Git's registration. Inspect the contents before confirming deletion.

## Other actions

**Copy PR description** collects the change/ticket description and repository pull-request links.
A repository without a pull request is still named. Terminal controls and agent briefing are
described in [terminals](terminals.md) and [configuration](configuration.md).
