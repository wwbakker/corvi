# Integrated Work Environment

A local dashboard for a *change*: the work spanning one or more repositories, plus the
worktrees, pull requests, tickets and builds around it.

State lives in one directory per change (`~/changes/<id>/`, `~/changes/archive/<id>/` once
completed), holding `change.json`, a `wt.toml` that points `wt` at that directory, and the git
worktrees themselves. Everything else (PR status,
ticket status, pipeline runs) is read live from the vendors' own CLIs, so this tool stores no
secrets and owns no copy of their data.

Creating a change provisions it: the Jira issue is assigned and moved to `In Progress`, and a git
worktree on the change's branch is created in every selected repository. Components that fail are
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

  A run still in flight shows the time it has been busy and a bar against the mean duration of
  that pipeline's last `IWE_AZURE_HISTORY` (default 10) finished runs, across branches. The clock
  ticks in the browser, so it stays smooth between the widget's 15s refreshes, and an overrun
  fills the bar and keeps counting.

  Azure DevOps reports `repository.name` as null, so pipelines are attributed to a repository by
  their pipeline folder (`\example-worker`), which mirrors the service directories of a
  monorepo. `IWE_AZURE_RUNS` (default 3) caps the runs shown per pipeline.

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
each component is fetched separately from `GET /api/changes/:id/:integration`. A card shows
"loading…" until its own integration answers, refreshes itself every 15s, and a slow or broken
CLI delays only its own card.

## Adding an integration

Implement `Integration` from `src/types.ts` (a `status(change)` returning a widget, optionally
`provision(change)` for the creation step and `run(change, action, arg)` for buttons) and add it to the table in `src/integrations/index.ts`. The UI
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
