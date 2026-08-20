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
  "reposStart": "~/Repos/acme/example-legacy",
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
`IWE_JIRA_START_TRANSITION`, `IWE_JIRA_DONE_TRANSITION`, `IWE_AZURE_ORG`, `IWE_AZURE_PROJECT`, `IWE_AZURE_RUNS`.

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
   a parent of repositories (`acme/example-legacy`) can be either. Selected repositories are listed on
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

      example-worker
      └─ #719 Fix the thing
         ├─ build-example-worker      2 run(s)
         │  ├─ 20260818.3                   succeeded
         │  └─ 20260818.2                   succeeded
         └─ deploy-example-worker     no runs for this branch

  A pull request row shows unresolved review threads in amber (`gh api graphql`, since neither
  `gh pr list` nor the REST API exposes resolution state) *and* the review decision, so
  `1 unresolved comment · approved` is visible as its own state. Resolved threads are not
  mentioned; `ready to merge` is reserved for an approval with nothing left open.

  A pull request that belongs to a GitHub stack says so: `1 of 2 in stack #163`, read in the same
  GraphQL query as the unresolved comments, so it costs no extra call. Where the preview feature
  is not enabled the query is repeated without those fields rather than losing the comment counts.

  A repository whose pipelines Azure DevOps does not know about — built by GitHub Actions, or by
  pipelines in another Azure project than the configured one — falls back to the checks the pull
  request itself reports. Those are grouped by the part of the name before the bracket, so a build
  with thirty jobs (`acme.frontend-app (CI App @acme/example-app)`) is one row you can open.

  A pipeline's own dot follows its **newest** run: an older failure that a later run fixed does
  not keep the pipeline, the repository or the whole CI card red. The failed run keeps its red dot
  in the list, where it belongs.

  A successful run also shows the artifact version its pipeline printed
  (`Version is: '…'`, `pushing manifest for …`, `Built and pushed image as …`, the patterns from
  `example-legacy-misc/scripts/version-from-pr`). Logs are searched newest step first, five at a time,
  and the answer is cached per run id: a finished build's logs never change.

  A run still in flight shows the time it has been busy and a bar against the mean duration of
  that pipeline's last `IWE_AZURE_HISTORY` (default 10) finished runs, across branches. The clock
  ticks in the browser, so it stays smooth between the widget's 15s refreshes, and an overrun
  fills the bar and keeps counting.

  Azure DevOps reports `repository.name` as null, so pipelines are attributed to a repository by
  their pipeline folder (`\example-worker`), which mirrors the service directories of a
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

## Terminals

Each change has a **Terminals** tab: one tmux session named `iwe-<change id>`, started in the
change directory, served into the page by [ttyd](https://github.com/tsl0922/ttyd)
(`brew install ttyd`).

ttyd is started when the change page is opened, not when the tab is clicked: the dashboard's CLI
calls occupy every connection the browser allows per origin, and a terminal asked for afterwards
waits behind them. For the same reason the dashboard cards are unmounted while the Terminals tab
is in front — otherwise their per-repository calls starve the window strip's polling. Returning
to the dashboard repaints from the cache and refreshes.

Above the terminal is a strip of the session's windows, labelled by **where they are** — the
directory of the pane, which is the repository you are in — with **what is running there** in
brackets after it: `example-service`, `example-web - (vim)`. A plain shell adds nothing, so it is
left out. Rename a window (`ctrl-b ,`) and your name replaces the directory, because tmux stops
renaming it for you at that point and so do we. A dot marks a window whose
output arrived while you were looking elsewhere, and `+` opens another. The keyboard stays in the
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
real thing, not a copy: `tmux attach -t iwe-PROJ-1627` from iTerm2 reaches exactly what the browser
shows, and the shells survive an IWE restart because tmux owns them, not us. ttyd listens on
`lo0` only.

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

## Notes on jira-cli output

Plain mode pads columns with the delimiter, so column positions cannot be recovered: issue
queries therefore use `--csv`. `sprint list --table` ignores `--csv` and pads with tabs, so its
rows are read by dropping empty fields. Both are covered by tests.

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

ttyd is started when the change page is opened, not when the tab is clicked: the dashboard's CLI
calls occupy every connection the browser allows per origin, and a terminal asked for afterwards
waits behind them. For the same reason the dashboard cards are unmounted while the Terminals tab
is in front — otherwise their per-repository calls starve the window strip's polling. Returning
to the dashboard repaints from the cache and refreshes.

Above the terminal is a strip of the session's windows, labelled by **where they are** — the
directory of the pane, which is the repository you are in — with **what is running there** in
brackets after it: `example-service`, `example-web - (vim)`. A plain shell adds nothing, so it is
left out. Rename a window (`ctrl-b ,`) and your name replaces the directory, because tmux stops
renaming it for you at that point and so do we. A dot marks a window whose
output arrived while you were looking elsewhere, and `+` opens another. The keyboard stays in the
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
real thing, not a copy: `tmux attach -t iwe-PROJ-1627` from iTerm2 reaches exactly what the browser
shows, and the shells survive an IWE restart because tmux owns them, not us. ttyd listens on
`lo0` only.

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

## Notes

Each change has a free-text note in the left column, stored as `notes.md` in its directory, so it
travels into the archive with everything else. It saves shortly after you stop typing, on blur,
and when you navigate away.

## Change state

Every change carries one of `In Progress`, `Awaiting Review` or `Completed`, chosen in the select
beside `Complete change` and shown as a column on the overview. It is kept by hand rather than
derived, because the tools disagree often enough (a merged pull request with the ticket still
open, a review that happened in a call) that your own answer is the useful one. Completing a
change sets it to `Completed`. Changes made before this existed read as `In Progress`.

## Actions

The `Actions` button on a dashboard holds what you can do to the change as a whole:

- **Copy PR description** — puts the ticket and one link per repository on the clipboard:

      PROJ-1627 - Anonimiseren van bezorgernamen op ACCEPTATIE omgeving (vanuit Security)
      https://github.com/acme/example-service/pull/720
      https://github.com/acme/example-deploy/pull/135

  A repository whose pull request does not exist yet is listed by name, so the list stays
  complete.
- **Complete change** — last in the menu, because it is the irreversible one.

## Completing a change

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
    src/repos.ts              directory browsing under reposRoot
    src/integrations/         git.ts (wt), github.ts, jira.ts, azure.ts, index.ts (the registry)
    src/server.ts             Bun.serve: /api/* plus the React app
    src/web/app.tsx           shell + changes list
    src/web/Wizard.tsx        per-component change wizard
    src/web/IssueTable.tsx    filterable Jira board table
    src/web/ChangeView.tsx    widget dashboard for one change
    src/web/RepoBrowser.tsx   repository picker
    src/web/manifest.webmanifest  installable app metadata
    src/web/icons/            generated from assets/*.svg by `bun run icons`
