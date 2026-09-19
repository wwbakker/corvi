# Changes

![A change's dashboard](../images/change.png)

A change groups work across repositories, associated tickets/pull requests, documents, and
terminals. Active changes live under `~/corvi/changes/<id>/`; finished records move to the
configured archive.

## Creating an idea

**New** opens the wizard. Enabled workspace integrations determine the available issue steps.
You can select or create a Jira issue, name the idea yourself, choose repositories, and optionally
select or create a GitHub issue for them. Both issue integrations can be used together.

The idea fields include title, description, ID, and branch name. ID and branch follow the title
until manually edited. Repositories are optional for an idea; the directory browser starts at
`repositoriesDirectory` and can navigate up to `/`.

Leaving the wizard preserves one draft in the page. It appears under **Ideas** as *New idea* or
its title. Reopening restores the fields and selections. **Discard** removes it; closing/reloading
the application forgets it. No server-side change exists until **Create idea**.

Creating an idea writes its record and `PLAN.md`. Selected repositories are linked for browsing;
no branch/worktree is created and no ticket moves. The **Plan** card edits the same file an agent
can read. **Brief the agent** pastes the configured briefing into the change's terminal.

**Start work** is the transition out of `Ideation`: it moves the state to `In Progress`, prepares
the selected checkouts, and moves associated tickets. Partial provisioning failures are reported
on the existing change so they can be addressed rather than losing the record.

## Repositories and worktrees

Each repository can be used in one of two modes:

- **Worktree:** a separate checkout in the change directory on its branch. The source repository
  keeps its current checkout.
- **In place:** the repository's checkout is switched to the change branch and linked into the
  change directory. If it has uncommitted work, it is linked without switching; the card reports
  the situation and offers the switch again later.

Choose a base branch per repository. The remote default is normally selected; another change's
branch can be used for stacked work. Pull requests target that base. Repositories without a remote
can still use local branches. Creating a worktree must not make the remote default branch the new
branch's push upstream.

The Local changes card's repository editor applies additions/removals together when confirmed.
Cancelling the editor changes nothing. An existing change's list may be emptied and repopulated.
Repositories with the same directory basename cannot share a change directory.

Removal safety is enforced on the server:

- Uncommitted work blocks removal, even with force.
- Unpushed commits require acknowledgement; the branch remains unless its contents are proven
  integrated into the default branch.
- Removing an in-place repository removes the link, not the user's checkout or branch.
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

The dashboard shows the plan and notes beside independently loaded integration status cards:
local worktrees, Jira, GitHub pull requests/checks, and Azure pipeline runs where enabled.
Narrow windows stack documents before status cards.

The **Review changes** tab shows per-repository staged/unstaged changes and diffs. Its commit and
push actions are described in [integrations and included features](integrations.md#review-changes).
Repository menus can open the relevant checkout in the file manager or IntelliJ when available.

## Names, state, and ordering

The active lifecycle states are:

```text
Ideation
In Progress
Awaiting Review
Blocked
```

Ideas are grouped separately; active work is ordered by state and then newest first. Finished
changes are listed separately as `Completed` or `Cancelled` and remain readable.

State is chosen by the user rather than derived from ticket or pull-request status. `Ideation`
is entered on creation and left through **Start work**, not the ordinary state selector.
A record without a state is treated as `In Progress`.

A change's title can come from its associated issue. Provider failures leave the last stored title
intact. Renaming through the change's Actions menu makes the title user-owned; clearing the edit
allows automatic naming again. Archived records retain their names.

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

The **Left behind** page lists directories in the changes root that no longer contain a change
record. They may hold build output or scratch files. Nothing is deleted automatically.

Deletion refuses a directory that still has `change.json` and leaves the archived copy alone.
Repositories and registered worktrees are identified in the confirmation; removed worktrees are
pruned from Git's registration. Inspect the contents before confirming deletion.

## Other actions

**Copy PR description** collects the change/ticket description and repository pull-request links.
A repository without a pull request is still named. Terminal controls and agent briefing are
described in [terminals](terminals.md) and [configuration](configuration.md).
