# Integrated Work Environment

A local dashboard for a *change*: the work spanning one or more repositories, plus the
worktrees, pull requests, tickets and builds around it.

State lives in one directory per change (`~/changes/<id>/`, `~/changes/archive/<id>/` once
completed), holding `change.json`, `notes.md`, a `wt.toml` that points `wt` at that directory, and the git
worktrees themselves. Everything else (PR status,
ticket status, pipeline runs) is read live from the vendors' own CLIs, so this tool stores no
secrets and owns no copy of their data.

Creating a change provisions it: the Jira issue is assigned and moved to `In Progress`, and a git
worktree on the change's branch is created in every selected repository. New branches start from
the remote's default branch (`origin/HEAD`, fetched first), never from a local `main` that may be
behind. Components that fail are
reported on the dashboard; the change itself is written first and always survives.

## Requirements

`git`, `wt`, `gh`, `jira` and `az` for the integrations; `tmux` and `ttyd` for the Terminals tab.

## Run

```bash
bun install
bun run dev          # http://127.0.0.1:4000
```

## Configuration

`~/.config/iwe/config.json` (override the location with `IWE_CONFIG`):

```json
{
  "changesRoot": "~/changes",
  "reposRoot": "~/Repos",
  "reposStart": "~/Repos/acme",
  "jiraAssignee": "",
  "jiraStartTransition": "In Progress",
  "jiraDoneTransition": "Done",
  "azureOrganization": "",
  "azureProject": ""
}
```

Empty values fall back to the CLIs' own configuration: `jira me` for the assignee, and
`az devops configure` for the Azure DevOps organisation and project.

`changesRoot` holds one directory per change; `reposRoot` bounds the repository browser and
`reposStart` is the directory it opens on, which `↑ Up` still walks out of, up to `reposRoot`.
Environment variables still win: `IWE_ROOT`, `IWE_REPOS_ROOT`, `IWE_REPOS_START`, `IWE_PORT`, `IWE_JIRA_ASSIGNEE`,
`IWE_JIRA_START_TRANSITION`, `IWE_JIRA_DONE_TRANSITION`, `IWE_AZURE_ORG`, `IWE_AZURE_PROJECT`, `IWE_AZURE_RUNS`,
`IWE_CACHE` (where the cache is stored) and `IWE_PARALLEL` (how many CLIs may run at once).

The server binds to localhost and runs as you: it has no auth of its own because it delegates
to `git`, `gh` and `jira`, which already hold your credentials (`gh auth login`, `jira init`).

`jira-cli` reads its token from `JIRA_API_TOKEN` in the environment, so start the server from a
shell that has it exported. Without it, the Jira widget reports the problem and the change picker
falls back to typing an id by hand.

## Creating a change

"New change" opens a wizard with one step per component:

1. **Jira** — a table of every issue in the open sprints plus the un-sprinted backlog, grouped
   by sprint (collapsible), sorted by assignee, then status, then key, and filterable by
   key/summary, assignee and sprint. Each row links to the issue in Jira. "Create new issue"
   opens a dialog for title and description; the new issue (assigned to you, type from
   `IWE_JIRA_ISSUE_TYPE`, default `Story`) is selected straight away. Skipping the step is fine:
   you can name the change yourself.
2. **Change** — id and branch, prefilled from the picked issue as `KEY-slugified-summary`,
   both editable.
3. **Repositories** — at least one is required, from a directory browser rooted at `reposRoot`. Clicking a name browses into
   it, the button beside it adds it to the selection: a directory that is both a repository and
   a parent of repositories (`acme/services`) can be either. Selected repositories are listed on
   the right and removed with the cross. A worktree is created per selected repository.

Only issue types in `IWE_JIRA_ISSUE_TYPES` (default `Story,Bug`) are listed: epics and subtasks
are containers, not units of work. A change may still link to any type directly.

Which sprints the table covers comes from `IWE_JIRA_SPRINT_STATES` (default `active,future`);
jira-cli has no sprint column, so the table is built from one query per sprint plus one for the
backlog, cached for 60s.

The dashboard shows three widgets, in this order:

- **Jira** — the issue, its status and assignee. No transition buttons: `In Progress` is set when
  the change is created, and `Done` belongs to completing the change as a whole.
- **Local changes** — the worktree per repository: clean or dirty, ahead/behind, merged.
On a window of 1280px or more the component that asks for it (`wide: true`, currently CI) gets a
column of its own beside the others; narrower windows stack everything.

- **CI** — per repository, the pull request and the pipeline runs it triggered, since "is this
  change green?" is one question even though two vendors answer it. Rows form a collapsible tree:

      example-api
      └─ #719 Fix the thing
         ├─ build-example-api                2 run(s)
         │  ├─ 20260818.3                   succeeded
         │  └─ 20260818.2                   succeeded
         └─ deploy-example-api               no runs for this branch

  A pull request row shows unresolved review threads in amber (`gh api graphql`, since neither
  `gh pr list` nor the REST API exposes resolution state) *and* the review decision, so
  `1 unresolved comment · approved` is visible as its own state. Resolved threads are not
  mentioned; `ready to merge` is reserved for an approval with nothing left open.

  Counted are the threads **waiting on you**: unresolved, and not last spoken in by you. Only the
  reviewer can resolve a thread, so a thread you answered stays unresolved for as long as they
  take to look at it — counting those made the number say you had work when you had none. Your
  own login comes from `viewer{login}` in the same query, so it costs no extra call. A thread
  whose last author cannot be read counts, since the safe answer to "is this mine?" is yes.

  The pull request is looked up by the branch that was **pushed**, not by the change's branch
  name: a branch that was renamed, or made around work that already existed, lives on the remote
  under another name, and the pull request belongs to that one. When the two differ the row says
  `pushed as <branch>`, because it is worth knowing. A branch still tracking `origin/main` is
  ignored — that is a mistake, not a pull request.

  A pull request that belongs to a GitHub stack says so: `1 of 2 in stack #163`, read in the same
  GraphQL query as the unresolved comments, so it costs no extra call. Where the preview feature
  is not enabled the query is repeated without those fields rather than losing the comment counts.

  A repository whose pipelines Azure DevOps does not know about — built by GitHub Actions, or by
  pipelines in another Azure project than the configured one — falls back to the checks the pull
  request itself reports. Those are grouped by the part of the name before the bracket, so a build
  with thirty jobs (`owner.frontend-app (CI App @scope/one-app)`) is one row you can open.

  A pipeline's own dot follows its **newest** run: an older failure that a later run fixed does
  not keep the pipeline, the repository or the whole CI card red. The failed run keeps its red dot
  in the list, where it belongs.

  A successful run also shows the artifact version its pipeline printed
  (`Version is: '…'`, `pushing manifest for …`, `Built and pushed image as …`, the patterns from
  a shell script that read the same lines). Logs are searched newest step first, five at a time,
  and the answer is cached per run id: a finished build's logs never change.

  A run still in flight shows the time it has been busy and a bar against the mean duration of
  that pipeline's last `IWE_AZURE_HISTORY` (default 10) finished runs, across branches. The clock
  ticks in the browser, so it stays smooth between the widget's 15s refreshes, and an overrun
  fills the bar and keeps counting.

  Azure DevOps reports `repository.name` as null, so pipelines are attributed to a repository by
  their pipeline folder (`\example-api`), which mirrors the service directories of a
  monorepo. Runs are looked up on both the pull request merge ref and the branch: validation
  builds run on the former, CI-triggered pipelines (publishing a client, say) on the latter. `IWE_AZURE_RUNS` (default 3) caps the runs shown per pipeline.

## Installing it as an app

The page ships a web manifest and icons, so it installs as a standalone macOS app:

- **Safari** — open the app, File → *Add to Dock*.
- **Chrome** — ⋮ → Cast, Save and Share → *Install page as app*.

Installed, the layout uses the full window (`@media (display-mode: standalone)`); in a browser tab
it keeps a readable 1200px column.

`http://127.0.0.1:4000` counts as a secure context, so no TLS is needed. The icon source is
`assets/icon.svg` (and `assets/icon-maskable.svg` for the padded, croppable variant); edit those
and run `bun run icons` to regenerate `src/web/icons/*.png` with `rsvg-convert`
(`brew install librsvg`). The generated PNGs are committed, so a clone serves them without it.

## Looking at the UI

```bash
bunx playwright install chromium   # once
bun run shot                       # screenshots the running app into shots/
```

Walks home → wizard → each step against `IWE_URL` (default `http://127.0.0.1:4000`) and reports
any console errors. Faster than describing a layout bug in prose.

## Notes on jira-cli output

Plain mode pads columns with the delimiter, so column positions cannot be recovered: issue
queries therefore use `--csv`. `sprint list --table` ignores `--csv` and pads with tabs, so its
rows are read by dropping empty fields. Both are covered by tests.

## Opening a repository

Every repository row in **Local changes** has a ⋯ menu: **Open in IntelliJ** and **Open in
Finder**. Both go through macOS's `open`, by application name, so nothing has to be installed on
the path. IntelliJ receives the project rather than being launched again, so where it lands — new
window, current window, or a prompt — is whatever *Settings > Appearance & Behavior > System
Settings > Open project in* says. The worktree is opened when there is one, the repository itself when it is used in
place.

## Changing which repositories a change touches

The pencil in the corner of the **Local changes** widget opens the repository list in the
wizard's browser. Adding and removing there only edits a draft; `OK` applies the whole list at
once and `Cancel` throws it away, so nothing is created or deleted while you are still deciding.

Applying an edit creates a worktree per added repository and removes one per dropped repository:

- clean worktree — removed straight away;
- unpushed commits — removed after a confirmation, since the checkout goes but `wt` keeps the
  branch, so the commits remain reachable;
- uncommitted changes — the whole edit is refused, naming the repositories: revert or commit
  first. The server enforces this, not the dialog.

## Worktree or in place

Each selected repository carries two choices, made in the boxes under its path:

**How it is worked on** — one of two ways:

- **Worktree** — a separate checkout on the change's branch inside the change directory. The
  repository you browsed from keeps whatever it was doing.
- **In place** — the repository's own checkout is switched to the change's branch (created from
  the remote default, after a fetch) and symlinked into the change directory, so the change
  directory still lists everything the change touches.

A repository with uncommitted work is linked but not switched: the card says which branch it is
on and offers the switch again once you have committed or stashed. Removing an in-place
repository, or completing the change, removes only the link — your checkout and its branch stay
exactly where they were.

**What it starts from** — the second box lists the remote's branches, newest first, with the
default (`origin/main`) selected. Choosing another change's branch stacks this work on top of it:
the worktree branches off there, and `gh pr create` targets that branch, so the pull request shows
your commits alone rather than both changes' together. GitHub retargets it to `main` by itself
once the branch below merges — and since these repositories squash-merge, rebase afterwards with
`git rebase --onto origin/main <branch-below> <your-branch>` rather than merging `main` in.

When the branch below has a pull request of its own, IWE also registers the two as a **GitHub
stack** (a public preview feature): the new pull request is appended to that stack, or a stack of
the two is created. Reviewers then see the order of the work, and merging the bottom one carries
the rest along. It is best effort — a repository without the preview feature, or a base branch
with no pull request, simply gets the correct base and nothing more.

Stacking is worth avoiding when you can simply wait for the change below to merge; two deep is
manageable, four is a research project every time the bottom one moves.

`reposStart` in the config sets the directory the browser opens on; `↑ Up` still walks back to
`reposRoot`.

## Terminals

Each change has a **Terminals** tab: one tmux session named `iwe-<change id>`, started in the
change directory, served into the page by [ttyd](https://github.com/tsl0922/ttyd)
(`brew install ttyd`).

A terminal outlives the server: ttyd is detached, its pid and port are written to
`terminal.json` in the change directory, and the next start adopts it if it is still answering.
Restarting IWE — which is constant while working on IWE itself — therefore costs you nothing, and
the page keeps working straight through it. Completing a change is what ends a terminal for good.

The **Terminals** tab shows how many windows the session has, so a build running in one of them is
visible from the dashboard.

ttyd is started when the change page is opened, not when the tab is clicked: the dashboard's CLI
calls occupy every connection the browser allows per origin, and a terminal asked for afterwards
waits behind them. For the same reason the dashboard cards are unmounted while the Terminals tab
is in front — otherwise their per-repository calls starve the window strip's polling. Returning
to the dashboard repaints from the cache and refreshes.

The **Terminals** tab carries its own state, in the same words the overview card uses: a green
dot and `2 active` when something is running in a window, a grey dot and `idle` when every window
is sitting at a prompt. Both count with `busyWindows` in `src/windows.ts` — pure and free of node
imports, so the page and the server cannot drift apart about what "busy" means.

Above the terminal is a strip of the session's windows, labelled by **where they are** — the
directory of the pane, which is the repository you are in — with **what is running there** in
brackets after it: `example-api`, `example-web - (vim)`. A plain shell adds nothing, so it is
left out. Rename a window (`ctrl-b ,`) and your name replaces the directory, because tmux stops
renaming it for you at that point and so do we.

A window running a **coding agent** says what the agent is doing — `example-api - (pi working)`,
`example-api - (pi waiting)` — instead of `node`, which says nothing. The agent reports that
itself, in the `@agent` **tmux pane option**, which `agentIn()` reads out of the same
`list-windows` call as everything else. The overview believes it over the process name: an agent
waiting for you is not work in progress, though its process is very much running.

`extensions/agent-state.ts` is that reporter for pi — `agent_start` sets `@agent working`,
`agent_settled` sets `waiting`, `session_shutdown` unsets it. Settled rather than ended, because
after `agent_end` pi may still retry, auto-compact or pick up queued messages, none of which are
"waiting for you".

```bash
bun run extension:install     # symlinks it into ~/.pi/agent/extensions/
bun run extension:uninstall
tmux display -p '#{@agent}'   # what the pane you are in says about itself
```

A symlink rather than a copy, so editing it here is editing the installed one and `/reload` in pi
picks it up; the script refuses to touch anything at that path it did not put there.

A pane option rather than the terminal title, which was the first attempt: the title is shared.
pi rewrites it whenever the session name changes — right after a run, when it names the session
from your first message — and the shell rewrites it between commands, so the marker kept
vanishing seconds after it appeared. Nobody else writes `@agent`, and tmux drops it when the pane
dies, so a crashed agent leaves nothing stale behind. The option is read from each window's
**active pane**, so an agent left in the inactive half of a split is not seen.

A dot marks a window whose output arrived while you were looking elsewhere, and `+` — or
**cmd-t** — opens another.

A new window starts **where the current one is**, not back in the change directory: a new tab is
almost always "the same place, another thing", and `#{pane_current_path}` is what tmux's own
`ctrl-b c` binding uses anyway. cmd-t works from inside the terminal too, where the keyboard
usually is: the injected key script cannot open a window itself, so it forwards the key to the
page around the frame. In a browser tab Chrome keeps cmd-t for itself; installed as an app it
reaches us. The keyboard stays in the
terminal throughout: the strip's buttons refuse the focus a mousedown would give them, and opening
the tab focuses the terminal, so you can type straight away. Clicking one selects it. tmux stays the source of truth — the strip calls
`list-windows`, `new-window` and `select-window`, so the keys keep working and a session attached
from a terminal stays in step.

Windows and panes are yours to make with the usual tmux keys — the **tmux cheat sheet** button
beside the tabs lists them — which is also the answer to "how do I get more than one terminal":
tmux does that, IWE does not duplicate it. Mouse mode is switched on for the session, so the wheel scrolls the
pane instead of walking through shell history; it is set with `-t`, so tmux sessions you started
yourself keep your own settings — a change needs no terminal at all
some days and three in one repository on others, so IWE opens none for you. The session is the
real thing, not a copy: `tmux attach -t iwe-PROJ-123` from iTerm2 reaches exactly what the browser
shows, and the shells survive an IWE restart because tmux owns them, not us. ttyd listens on
`lo0` only.

**Shift-Enter and Ctrl-Enter.** A browser terminal cannot encode these by itself: xterm.js sends a
carriage return for Enter whatever modifier is held — there is no legacy encoding for a modified
Enter, and it implements neither of the modern ones. So IWE serves ttyd from its own origin, and
injects a small script that sends the CSI u sequence instead (`ESC [13;2u` for shift, `;5` for
ctrl, `;6` for both). tmux is started with `extended-keys on`, which passes those through to
applications that ask for them — which is what an application means when it says *"tmux
extended-keys is off. Modified Enter keys may not work."*

Shift-Tab has always worked because it *does* have a legacy encoding (`ESC [Z`), which is the
difference between the two keys.

Copying out: the mouse belongs to tmux while mouse mode is on, so hold **option** while dragging
to get the browser's own selection, then ⌘C. (Option, not shift: that is the modifier xterm.js
honours on macOS, and only because ttyd is started with `macOptionClickForcesSelection=true`.) A
drag without it is tmux's selection, which lands in a tmux buffer (`ctrl-b ]` pastes it) and not in the Mac clipboard — this build of ttyd has no
OSC 52 support, so tmux cannot reach the system clipboard by itself.

A terminal that comes up blank: ttyd logs to `/tmp/iwe-ttyd-<change id>.log`, and the session is
reachable from a normal terminal, which tells you quickly whether the problem is tmux or the
browser. After changing the manifest, reinstall the app — Chrome keeps the old one otherwise.

Completing a change kills its session and ttyd, since the change directory moves into the archive
underneath it.

## Local changes

The last tab: everything uncommitted across the change on the left, the diff of whatever you
click on the right — an IDE's local-changes window, for a unit of work that spans repositories
rather than for one checkout.

The list is grouped by repository, each with a dot and what it amounts to:

    example-worker
    ● clean

    example-web
    ● 2 changes
      M app.ts   src    staged  modified
      M README.md              modified

A row is one line, always: the filename keeps its width until there is none left, the directory
gives way first — losing its front, since the last segments are what tell two files with the same
name apart — and the full path is in the tooltip. Wrapping a path breaks it character by
character, which spells a filename down the side of the pane.

A clean repository keeps its heading rather than disappearing: one repository clean and another
not is the normal case, and the absence is worth seeing rather than inferring from a missing
row.

Staged rows come first and are tagged `staged`, because that is the order they will be committed
in — and a file with staged edits *and* more edits on top appears twice, which is what git means
by both: the same path, two different diffs, which is why the staged flag travels with the diff
request. Untracked files are diffed against nothing (`git diff --no-index` against `/dev/null`,
which is how git itself shows a file it does not know).

The list is re-read every three seconds, and the diff with it: you edit in the terminal or an IDE
while this is open, and watching your own edits appear is the point. `git status` costs about
five milliseconds, so nothing here is cached — a second-old answer about the file you are editing
is a wrong one.

Status comes from `git status --porcelain=v2 -z`. Version 2 rather than the older format because
v1 begins a line with a space when only the working tree changed (` M file`), and `sh` trims what
a CLI prints, which quietly ate the first character of every unstaged path. NUL-separated because
paths may contain anything, including newlines; a rename puts the old path in the next field,
which is why the parser walks the list rather than mapping over it.

Read-only for now: staging, unstaging and discarding are the obvious next step, and all three
destroy work if they are wrong, so they want more care than a click.

## Notes

Each change has a free-text note in the left column, stored as `notes.md` in its directory, so it
travels into the archive with everything else. It saves shortly after you stop typing, on blur,
and when you navigate away.

## Left behind

Under the changes list is a card for directories in the changes root that no longer belong to a
change: what a completed one left behind — a build's `target/`, a shell's history, the terminal's
note — or a change that was never finished being created. Each one opens to show what is in it,
with its size, and a Delete button. Nothing is removed on your behalf: `target/` is rubbish, the
scratch file next to it might not be.

Deletion refuses anything that still has a `change.json`, so an active change cannot be tidied
away by accident, and the archived copy of a completed change is untouched — only the directory
that outlived it goes.

Directories inside a leftover are labelled when git cares about them: `git worktree` for one still
registered with its repository, `git repository` for a clone with a history of its own. Both are
named in the confirmation, and after deleting a worktree the repository is pruned, so git does not
keep a registration for a path that is gone.

## The overview

The front page is two lists, because they are read for two reasons.

A change is named by **its ticket's summary** — "Anonymise customer names on the acceptance
environment" — rather than its branch, which says how the work is spelled and not what it is. A
change without a ticket shows its branch instead, in monospace, since that is an identifier and
reads as one.

The summary is stored in `change.json` the first time it is read, so the list carries it and the
page is complete the moment it loads; `GET /api/titles` then refreshes every change on the page
in **one** `jira` query and writes back what changed. A Jira that answers nothing — down,
unauthenticated, ticket deleted — leaves the stored name alone rather than falling back to a
branch nobody recognises, and an archived change keeps its name for good.

**Active changes** are cards, one per change and the full width of the page, in two rows: **what
it is** — the id and the ticket's summary, which read as one sentence — and underneath, **how it
is doing** — the facts on the left, state and dates on the right. A table row has no space for
the second row, which is the reason these are cards at all. Below 720px the bottom row becomes
as many lines as it needs. Besides the branch, the repository count and when it
started, each card carries three facts, fetched per card from `/api/changes/:id/summary`:

- `2 pipelines active` / `pipelines idle` — runs in flight across every repository.
- `2 terminal processes active` / `terminals idle` — tmux windows running something that is not
  a shell: a build, an editor, a server. An agent that marks its title is taken at its word, so
  one sitting at its prompt does not count.
- `3 unresolved comments` — threads waiting on you, as on the dashboard: unresolved and not last
  answered by you. **Nothing at all** when there are none: an empty inbox needs no line, and a
  row of zeroes is noise.

Idle facts are grey, so the eye lands on the cards that want something. One request per card,
because those numbers cost CLI calls: a change whose Azure DevOps is slow delays its own card and
no other. The queries behind them are the cached ones the dashboard already makes
(`activeRuns` skips durations, logs and versions; `prSummary` asks the pull request only for its
open threads), so a change you have open answers immediately.

**Completed changes** stay a table — id, story, repositories, created, completed. No state
column: every row in it is `Completed`, which is what the heading says.

## Change state

Every change carries one of `In Progress` (amber), `Blocked` (purple), `Awaiting Review` (blue)
or `Completed` (green), chosen in the select beside `Complete change`, and it decides which half
of the overview a change appears in — only `Completed` is finished.

`Blocked` is waiting on something you cannot do yourself: an answer, a decision, another change.
That is a different thing from `Awaiting Review`, which is waiting on a named person to look at
work that is done, and the distinction is worth a colour because one of them is your problem to
chase and the other is not.

The state is kept by hand rather than derived, because the tools disagree often enough (a merged
pull request with the ticket still open, a review that happened in a call) that your own answer
is the useful one. Completing a change sets it to `Completed`. Changes made before this existed
read as `In Progress`.

## Actions

The `Actions` button on a dashboard holds what you can do to the change as a whole:

- **Copy PR description** — puts the ticket and one link per repository on the clipboard:

      PROJ-123 - Anonymise customer names on the acceptance environment
      https://github.com/owner/example-api-service/pull/720
      https://github.com/owner/example-deploy/pull/135

  A repository whose pull request does not exist yet is listed by name, so the list stays
  complete.
- **Complete change** — last in the menu, because it is the irreversible one.

## Completing a change

A pull request that belongs to a GitHub stack cannot go through the ordinary merge: GitHub
refuses, because merging one takes everything below it along and that runs in the background.
Those are merged with the asynchronous merge API instead — submit, then poll until it is no
longer pending — and a stack that lands in a merge queue rather than on the branch is reported as
such, because the change is then finished here but not yet on main.

Every step is written to `completion.json` in the change directory as it starts and as it
finishes, and the **Completing** card shows it: which step is running, which are done, and where
it stopped. Because it is on disk rather than in the page, a completion that fails is legible
afterwards — from a page opened later, or after a restart — and `Try again` picks up what is
left, since a merge that already happened is no longer outstanding.

The first thing recorded is the readiness check itself, before it runs — it is slow, and a page
that just asked for a completion should see something at once. A refusal ("not approved yet") is
recorded there too, rather than only in the page that asked.

The card stays for completions that finished, so an archived change still shows what was done and
when. A change that was never completed has no card. A completed change no longer starts a terminal: doing so would write into a directory
that has just moved to the archive, and the change would then be listed twice, once under each
name. It is listed once regardless, since a leftover directory (a build's `target/`, a shell's
history) is not a second change.

`Complete change` on a dashboard squash-merges every outstanding pull request and moves the Jira
issue to `jiraDoneTransition` (default `Done`), then records `completedAt` in `change.json`.

It refuses unless **every** repository is either already merged by hand or has an approved,
conflict-free, non-draft pull request — a change lands as a whole or not at all. Hovering the
disabled button lists what blocks it, one line per repository, and the check runs server-side
too, so the refusal is not just a disabled button. Merges run sequentially: if one fails, the ones after it have not happened.

Squash is the only merge method both repositories allow, and they delete the remote branch
themselves. Once the merges succeed the local worktrees hold nothing the remote does not, so they
are removed and the change directory is moved to `~/changes/archive/<id>/`. Archived changes are
still read, written and listed exactly like active ones.

Completion is therefore also refused when a worktree has uncommitted changes or unpushed commits,
even if the pull request is approved: removing it would throw that work away.

## Routing

`/` lists changes, `/new` is the wizard, `/changes/<id>` is a dashboard. Navigation uses
`history.pushState`, the server serves the app for any non-`/api` path, so deep links, reload and
the browser's Back button all work.

## Caching

Everything on a page costs a subprocess, and the same answers are wanted by the overview, the
dashboard and the summaries within seconds of each other. `src/cache.ts` is one
stale-while-revalidate store for all of them:

```typescript
swr(`az:runs:${ref}`, 10_000, () => sh(["az", "pipelines", "runs", "list", ...]))
```

The first caller waits; everyone after that gets the stored answer at once. Past the ttl the
stored answer is still handed over immediately and a refresh runs behind it, so a page paints
from what was true a moment ago instead of waiting for what is true now. Callers asking at the
same moment share one run — six repositories asking Azure DevOps about the same branch is one
`az`.

Two rules keep that honest, and they are in the code rather than only here:

- **Decisions never read the cache.** `completionOf`, `mergeReadiness` and the merge itself call
  the CLIs live. A pull request that was approved ninety seconds ago is not a merge. The display
  path (`prItem`, `prSummary`) uses the cached lookup; `mergeReadiness` uses the raw one.
- **A failed refresh keeps the last good answer.** A Jira that is down means "no news", not "no
  data". With nothing to fall back on, the failure is the answer.

Actions forget what they just made wrong: `createPr` invalidates `gh:pr:<change>`, `moveIssue`
invalidates `jira:`.

What is cached, and for how long: pipeline definitions 5min, pipeline runs 10s, expected build
durations 5min, pull requests and their review threads 20s, pull request checks 15s, Jira issues
60s. Anything `git` answers is not cached — it costs about five milliseconds and changes while
you type.

The store is written to `~/.cache/iwe/state.json` every 30 seconds and on exit, and read at
startup (`IWE_CACHE` overrides the path). Restarting is normal — a config change, a crash, an
edit `bun --hot` cannot take — and without it every page waits for the CLIs all over again.
Entries older than six hours are not restored: a page painted from yesterday's builds is worse
than a page that waits.

Subprocesses are bounded at eight at once (`IWE_PARALLEL`). A dashboard of six repositories asks
about thirty things in parallel, and `az` is a few hundred milliseconds of CPU each; queueing
them costs nothing in wall time and keeps the machine usable while it happens.

## The cost of a refresh

The dashboard is CLI calls, and they are not all alike. `IWE_TRACE=1` counts them and adds up
what each tool costs; measured on a six-repository change, one refresh used to be **131 processes
and 180 seconds of CPU**, and is now **60 processes and 6 seconds**. What changed:

- **Worktree state is read with git, not `wt list`.** `wt list` gathers CI, diffs and summaries in
  parallel and costs 1-13 seconds of CPU per call; `git worktree list --porcelain` plus
  `git status --porcelain=v2` costs ~25ms and answers everything the card shows. wt still creates
  and removes worktrees — it owns where they live.
- **Azure DevOps calls are shared.** `az` is a Python program, a few hundred milliseconds of CPU
  per invocation, and every repository of a change asks about the same branch at the same moment.
  Pipeline definitions are held for five minutes, runs for five seconds, and calls in flight are
  shared outright.
- **`origin/HEAD` is asked once per repository**, not twice per repository per refresh.

The rest is network-bound rather than CPU-bound: `gh` and `jira` are Go binaries that spend their
time waiting.

## Dashboard loading

The page renders immediately: `GET /api/changes/:id` returns the change with no CLI calls, and
each component is fetched separately.

Every card cancels its requests when it goes away. Without that, the ten-odd slow per-repository
requests of a big change keep saturating the browser's six connections per origin (HTTP/1.1 on
localhost, so no multiplexing), and the next page waits seconds for a free one: measured at
2387ms for `GET /api/changes` mid-load versus 4ms idle.

Widget data is kept in a small in-memory cache in the browser (`src/web/cache.ts`), keyed by
change, component and repository, so leaving a change and coming back paints the last known rows
straight away while they refresh in the background. A page reload starts empty.

Components that work per repository (Local changes, CI) declare `repoStatus` instead of `status`,
and the browser fetches `GET /api/changes/:id/:integration/repo?path=…` once per repository. The
rows appear one at a time as each repository answers, so a change with many repositories fills in
progressively instead of staying empty until the slowest CLI call returns. Everything refreshes
every 15s, and a slow or broken CLI delays only its own row.

## Adding an integration

Implement `Integration` from `src/types.ts`: either `status(change)` for a whole widget or
`repoStatus(change, repo)` to be fetched a repository at a time, optionally `provision(change)`
for the creation step and `run(change, action, arg)` for buttons and add it to the table in `src/integrations/index.ts`. The UI
renders whatever widgets come back; no frontend change needed.

## Testing the terminal

`test/terminal.test.ts` drives the real thing: it starts a server on a temporary root, opens the
Terminals tab in Chromium, types `pwd > out.txt` into the frame and reads the file back, then
checks `ctrl-b c` reaches tmux, mouse mode is on, and that asking twice reuses one ttyd. It skips
itself when `ttyd` or `tmux` is missing rather than failing.

## Layout

    src/changes.ts            change.json read/write, worktree paths
    src/branch.ts             branch-name derivation (shared with the browser)
    src/config.ts             config file + env overrides
    src/repos.ts              directory browsing under reposRoot, remote branches
    src/leftovers.ts          directories in the changes root without a change
    src/description.ts        the pull request description an action copies
    src/cache.ts              stale-while-revalidate for everything the CLIs answer
    src/summary.ts            the numbers on an overview card
    src/windows.ts            which tmux windows count as busy (page and server share it)
    src/local.ts              uncommitted work in a repository, and one file's diff
    src/titles.ts             what a change is called, from its ticket
    src/terminal.ts           tmux sessions and the ttyd that serves them
    src/terminalProxy.ts      ttyd proxied through our origin, and the key-fixing script
    src/integrations/         git.ts (wt), jira.ts, azure.ts, index.ts (the registry)
                              github.ts (pull requests) + checks.ts, stacks.ts
                              ci.ts joins pull requests, pipelines and checks into one card
    src/server.ts             Bun.serve: /api/* plus the React app
    src/web/app.tsx           shell + changes list
    src/web/Wizard.tsx        per-component change wizard
    src/web/IssueTable.tsx    filterable Jira board table
    src/web/ChangeView.tsx    widget dashboard for one change
    src/web/RepoBrowser.tsx   repository picker: mode and base branch per repository
    src/web/TerminalPane.tsx  the terminal tab, with WindowStrip.tsx and CheatSheet.tsx
    src/web/NotesCard.tsx     notes.md for a change
    src/web/CompletionCard.tsx  how far completing a change got
    src/web/ChangeCard.tsx      one active change on the overview
    src/web/LocalPane.tsx       the local-changes tab: files, and a diff
    extensions/agent-state.ts   pi extension: publishes working/waiting to tmux
    scripts/extension.ts        installs/removes that extension
    src/web/manifest.webmanifest  installable app metadata
    src/web/icons/            generated from assets/*.svg by `bun run icons`
    test/changes.test.ts      change.json, notes, in-place provisioning, base branches
    test/repos.test.ts        editing a change's repositories against real git repositories
    test/terminal.test.ts     the terminal tab end to end (skipped without ttyd/tmux)
    test/cache.test.ts        the cache: sharing, staleness, failure, restarts, parallelism
    test/provision.test.ts    the pure logic of every component
