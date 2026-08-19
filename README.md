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
  "jiraAssignee": "",
  "jiraStartTransition": "In Progress",
  "jiraDoneTransition": "Done",
  "azureOrganization": "",
  "azureProject": ""
}
```

Empty values fall back to the CLIs' own configuration: `jira me` for the assignee, and
`az devops configure` for the Azure DevOps organisation and project.

`changesRoot` holds one directory per change; `reposRoot` is where the repository browser starts.
Environment variables still win: `IWE_ROOT`, `IWE_REPOS_ROOT`, `IWE_PORT`, `IWE_JIRA_ASSIGNEE`,
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
