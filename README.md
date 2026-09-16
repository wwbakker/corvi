# Corvi

[![CI](https://github.com/wwbakker/corvi/actions/workflows/ci.yml/badge.svg)](https://github.com/wwbakker/corvi/actions/workflows/ci.yml)

**An agent-ready development environment for a change.** Corvi is a local dashboard for a
*change*: the work spanning one or more repositories, plus the worktrees, pull requests, tickets
and builds around it — and the terminals where you and your agents do the work.

State lives in one directory per change (`~/changes/<id>/`, `~/changes/archive/<id>/` once
completed), holding `change.json`, a `wt.toml` that points `wt` at that directory, the git
worktrees themselves, and per-extension files under `extensions/<name>/` (the notes extension's
`notes.md`, say). Everything else (PR status,
ticket status, pipeline runs) is read live from the vendors' own CLIs, so Corvi stores no
secrets and owns no copy of their data.

Corvi grew up as *IWE* (Integrated Work Environment): a few environment variables (`IWE_*`),
the config directory (`~/.config/iwe`) and the tmux socket still carry that earlier name.

A change begins as an **idea**: a title, a plan (`PLAN.md`), and a conversation with an agent in
the change's terminal — before any branch or worktree exists. Creating an idea touches nothing
outside `~/changes/<id>/`; starting the work is what creates each repository's checkout and
moves the Jira issue to `In Progress`. New branches start from the remote's default branch
(`origin/HEAD`, fetched first), never from a local `main` that may be behind. Components that
fail are reported on the dashboard; the change itself is written first and always survives.

## Requirements

`git`, `wt`, `gh` and `az` for the integrations; `tmux` for the Terminals tab. Jira is
talked to over its own REST API, but `jira-cli` is still what configures it — see below.

The terminal's pty is `node-pty`, installed with the rest of the dependencies. Its prebuilt
binaries cover macOS and Linux on x64 and arm64, so `bun install` needs neither a C toolchain nor
python3; a platform they do not cover falls back to `node-gyp` and does. It is pinned to a `1.2.0`
beta, for the reason in [`docs/decisions/node-pty-prebuild.md`](docs/decisions/node-pty-prebuild.md).

The same list applies on Linux (on Arch: `sudo pacman -S git worktrunk gh github-cli tmux`).
`wt` is [Worktrunk](https://github.com/max-sixty/worktrunk) — a cross-platform Rust CLI with an
official Arch package, and every invocation Corvi makes was verified to behave identically on Linux
(`brew install worktrunk` on macOS; details and non-Arch installs in `docs/decisions/wt-on-linux.md`).

The app's own window needs nothing extra on either platform: it is Electron, which `bun install`
downloads with the rest of the dependencies (`docs/decisions/electron-host.md`), and the server
inside it runs on Electron's own Node — so Bun is the toolchain for installing and developing
Corvi, not something an installed app needs at runtime (`docs/decisions/node-server.md`). The page
itself is still a web page — any browser opens it. Developing needs Node 24+ as well: `bun run
dev` starts the server with `node --watch`, and `bun test` spawns its servers with `node`,
because the terminal's pty library delivers nothing under Bun
(`docs/decisions/node-pty-terminal.md`).

## Run

```bash
bun install
bun run dev          # http://127.0.0.1:4000
```

`dev` is `node --watch` (Node 24+): a restart rather than a re-evaluation of modules inside the
running process. The difference matters here: the server takes its routes once,
at startup, so under `--hot` a **newly added route never appears** — the request falls through to
the app's own HTML and arrives as a perfectly good `200 text/html`. The page then tries to parse
that as JSON and reports whatever the browser calls a parse error (Safari: "The string did not
match the expected pattern"), which is a sentence about nothing. Restarting is cheap: the cache
is on disk and the terminals belong to tmux, so both survive it.

The page is built by esbuild (`src/app-root/client.ts`) and, in development, rebuilt when its
sources change — editing the UI is a refresh, not a server restart.

The browser now says so plainly instead — anything answering an `/api` call with a non-JSON body
is reported as "the server has no /settings — it is probably running older code, restart it".

## Configuration

`~/.config/iwe/config.json` (override the location with `IWE_CONFIG`):

```json
{
  "changesRoot": "~/changes",
  "reposRoot": "~/Repos",
  "reposStart": "~/Repos/acme",
  "ideationPrompt": "",
  "extensionSettings": {
    "jira": { "assignee": "", "startTransition": "In Progress", "doneTransition": "Done" },
    "azure-devops": { "organization": "", "project": "" }
  },
  "worktreeCopy": [".idea", ".bsp", ".bloop", ".scala-build", ".metals", ".vscode"]
}
```

The Jira and deployment settings are the extensions' own — `extensionSettings[name][key]`, the
keys each extension declares (docs/guides/extensions.md). Empty values fall back to the tools' own
configuration: the account the Jira token belongs to (`/myself`) for the assignee, and
`az devops configure` for the Azure DevOps organisation and project. The flat fields
(`jiraAssignee`, and the retired `azureOrganization`/`azureDeploy` fields the azure-devops
extension reads from the file, …) are still read when the bag does not
answer, and the `IWE_*` environment variables beat them — which is why the settings page locks
a field while its variable is set.

`changesRoot` holds one directory per change; `reposRoot` bounds the repository browser and
`reposStart` is the directory it opens on, which `↑ Up` still walks out of, up to `reposRoot`.
`ideationPrompt` is the briefing pasted into an idea's terminal by **Brief the agent**
(`{id}`, `{title}`, `{plan}` and `{state}` are filled in from the change); an empty value uses the
built-in one. Environment variables still win: `IWE_ROOT`, `IWE_REPOS_ROOT`, `IWE_REPOS_START`, `IWE_PORT`, `IWE_JIRA_ASSIGNEE`,
`IWE_JIRA_START_TRANSITION`, `IWE_JIRA_DONE_TRANSITION`, `IWE_AZURE_ORG`, `IWE_AZURE_PROJECT`, `IWE_AZURE_RUNS`,
`IWE_CACHE` (where the cache is stored), `IWE_PARALLEL` (how many CLIs may run at once),
`IWE_CLI_TIMEOUT` (seconds a CLI may run before it is killed; 120 by default, 0 disables) and
`IWE_WORKTREE_COPY` (see below; empty disables it).

### The settings page

Everything above is editable at `/settings`, last in the navigation column — the file stays the
source of truth and stays hand-editable, the page just writes it. Its tabs are the locations, the
worktrees, the extensions, the notification sound, the ideation prompt, the workspaces, and the
window — whose one setting so far is the right-click menu: the browser's own, which the app's window
draws for itself since Electron has none (docs/decisions/host-context-menu.md). **Saving takes effect at once**:
the server refills the config object every module already imported rather than replacing it, so
there is no restart and no "changes will apply next time".

Two conventions run through the page:

- **An empty field is "not set"**, and shows what applies anyway as its placeholder. So the
  difference between a default and a decision stays visible, and clearing a field removes the key
  from the file rather than writing an empty string into it.
- **A setting an environment variable is overriding is locked**, with the variable named next to
  it. The variable wins, so an editable box would be a lie.

It writes by merging over what the file holds, so a key Corvi does not know about — put there by
hand, for a newer version — survives being saved by an older one. Validation lives on the server
because the file can also be edited by hand: rules in the browser only would be rules that half
the ways in ignore. It refuses a relative path, a duplicate or non-word workspace id, a nameless
workspace, an environment name that is not one, and a `worktreeCopy` entry that is a path rather
than a name — `../.ssh` is not something a settings page should be able to ask for.

Saving also clears the cache. Everything the CLIs answered, they answered under the settings
that just changed: another organisation, another Jira site, another set of environments.

The server binds to localhost and runs as you: it has no auth of its own because it delegates
to `git`, `gh` and `az`, which already hold your credentials (`gh auth login`, `az login`), and
to the Jira token in your environment.

**Requests from other sites are refused.** Localhost keeps other machines out but not the browser
you already have open: any website can `POST http://127.0.0.1:4000/api/changes`, and while it
cannot read the answer — no CORS headers are sent — it does not need to read anything to create a
change or delete a leftover. Browsers say where a request came from (`Sec-Fetch-Site` on
everything, `Origin` on anything that is not a plain navigation), so anything that names another
site gets a 403. Requests with neither header — `curl`, the tests — are allowed: nothing can be
tricked into making one of those on your behalf.

The check wraps the route table in one place rather than being repeated in each handler, because
a check you have to remember in forty places is a check that is missing from one of them.

Jira is reached over its REST API, with HTTP basic auth: the account email and the token from
`JIRA_API_TOKEN`, so start the server from a shell that has it exported. Without it, the Jira
widget reports the problem and the change picker falls back to typing an id by hand.

**The site, account, board and project come from `jira-cli`'s own config file**
(`~/.config/.jira/.config.yml`, or `JIRA_CONFIG_FILE`), so `jira init` is still the setup step and
nothing is configured twice. The CLI is not called at runtime: four values are read out of the
config file it wrote, and the rest is HTTP.

## Creating an idea

**New** — the same button the column has, beside `Changes` — opens a wizard whose steps are its
extensions', in phases — the issue steps first (they prefill the idea), then the idea details, then
the repositories, then steps that want the repositories. Which steps a context has is resolved per
workspace; an extension that is not enabled there has no step, not an empty one.

1. **Jira** — a table of every issue in the open sprints plus the un-sprinted backlog, grouped
   by sprint (collapsible), sorted by assignee, then status, then key, and filterable by
   key/summary, assignee and sprint. Each row links to the issue in Jira. "Create new issue"
   opens a dialog for title and description; the new issue (assigned to you, type from
   `IWE_JIRA_ISSUE_TYPE`, default `Story`) is selected straight away. Skipping the step is fine:
   you can name the change yourself.
2. **GitHub issue** (after the repositories) — the open issues of the repositories picked on the
   step before, from the GitHub remote each one pushes to; a repository without one says so.
   Pick an issue or create one (`gh` does it, in the first selected repository); the picked
   issue prefills the change, names it on the overview, shows on the dashboard as its own card
   and is closed when the change completes. Both this step and the Jira step can be on at once:
   two tickets on one change is a thing, not a conflict.
3. **Idea** — Title (which the id and branch follow: "Ideation Stage" becomes `ideation-stage`),
   Description (the starting text of `PLAN.md`), Change id and Branch name (both editable, and both
   stop following the title once you touch them), and the Ticket the issue step picked. Skipping the
   issue steps is fine: type a title and you have an idea.
4. **Repositories** (optional) — from a directory browser rooted at `reposRoot`. Clicking a name
   browses into it, the button beside it adds it to the selection: a directory that is both a
   repository and a parent of repositories (`acme/services`) can be either. Selected repositories
   are listed on the right and removed with the cross. A repository picked now is linked into the
   change directory for reading, without switching its branch or creating a worktree; **Start
   work** turns that link into the checkout, so an idea that never starts leaves no branch behind.

Creating an idea writes `change.json` and `PLAN.md` and provisions nothing else: no branch, no
worktree, and no ticket transition. Its page has a **Plan** card — editable, the same `PLAN.md`
the agent reads, and still there (read-only once the change is finished) when the work starts —
and a **Brief the agent** button that pastes the configured prompt into the change's terminal. **Start work** is the one action that leaves the ideation stage: it moves the
state to `In Progress`, creates each repository's checkout (in place or a worktree, as the
repository list says), and moves the ticket.

Each step's pick is stored on the change under the step's extension's name — `change.json`'s
`extensions` bag — so completing the change knows what to close, and the core never had to know
what a ticket was.

Only issue types in `IWE_JIRA_ISSUE_TYPES` (default `Story,Bug`) are listed: epics and subtasks
are containers, not units of work. A change may still link to any type directly.

Which sprints the table covers comes from `IWE_JIRA_SPRINT_STATES` (default `active,future`). An
issue's sprint is which query found it rather than a field on it, so the table is built from one
call per sprint plus one for the backlog, cached for 60s.

The dashboard shows three widgets, in this order:

- **Jira** — the issue, its status and assignee. No transition buttons: `In Progress` is set when
  the change is created, and `Done` belongs to completing the change as a whole.
- **Local changes** — the worktree per repository: clean or dirty, ahead/behind, merged.
  Reviewing and committing what is uncommitted here is the **Review changes** tab, below.
- **GitHub** — per repository, the pull request and the checks it reports: "is this
  change green?", from GitHub's side. Rows form a collapsible tree, with the checks grouped by
  the part of the name before the bracket.
- **Azure DevOps** — per repository, the pipeline runs it triggered, beside the GitHub card.
  Rows form a collapsible tree:

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

  The GitHub card always shows the checks the pull request itself reports — GitHub Actions,
  Azure Pipelines in any project, whatever the repository has bolted on — grouped by the part of
  the name before the bracket, so a build with thirty jobs
  (`owner.frontend-app (CI App @scope/one-app)`) is one row you can open. The Azure DevOps
  card stays silent for a repository its pipelines do not know about: no row at all, rather than
  a row saying so.

  A pipeline's own dot follows its **newest** run: an older failure that a later run fixed does
  not keep the pipeline, the repository or the whole card red. The failed run keeps its red dot
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

The dashboard's left column holds the change's documents — the plan, and Notes — while every
status card sits to the right. On a window narrower than 1280px the two columns stack,
documents first.

## The app

```bash
bun run app:install      # macOS: ~/Applications/Integrated Work Environment.app
bun run app:uninstall    # Linux: desktop entry, icons and the iwe-app launcher
```

A real application: an icon the app grid knows, a window whose title bar is the page's own first
row — no band of the system's above it. On the change pages that row is the change's name with its
terminals beside it, and the row under it is the change's own tabs with its state and its actions;
both stay put while the page scrolls (`docs/decisions/window-titlebar.md`) — and the server inside
it. Clicking it **starts the app's own server — on a fresh port, picked at launch** — shows
"Starting Corvi…" on the page's own background while it waits, then loads the app.

**The app always runs the production build, on a fresh port.** `bun run dev` keeps 4000. A shared
port would let the window attach to whatever is listening there: a dev server left running from
last week would silently become "the app", with last week's code and no way to tell from the
window, which is how a missing `/api/settings` surfaces as "The string did not match the
expected pattern". A port of its own avoids that, but a *stale* server can still be sitting on a
fixed one. So the window picks a free port at each launch and starts its own server on it: there
is nothing to attach to by mistake, and nothing to collide with.

The two are separate things rather than two ways to start the same thing:

| | `bun run dev` | the app |
| --- | --- | --- |
| for | editing Corvi | using Corvi |
| port | 4000 | fresh each launch |
| build | rebuilt as you edit | built once, `NODE_ENV=production` |
| on a code change | restarts itself (`--watch`) | picks it up when you next launch it |
| output | your terminal | macOS: `~/Library/Logs/iwe.log` · Linux: `~/.local/state/iwe/log` |

It is one Electron main process (`scripts/app/electron/main.ts`) on both platforms: the installer
builds it into the app's bundle — a macOS `.app` that wraps Electron, or, on Linux, the desktop
entry, icons and `iwe-app` launcher that runs it — and the window loads the same HTTP server any
browser opens. Quitting the app stops the server it started; a server you started yourself, in a
terminal, is left alone. The app is a convenience, not the product.

What the window buys over a Chrome `--app` window:

- **A dark window from the first frame.** `backgroundColor` and a dark appearance, where a plain
  `--app` window flashes white before the page paints.
- **A Dock icon that means something**: it is there while Corvi is running, and Quit stops it.
- **cmd-t is ours.** Chromium keeps it for new tabs in a browser; the app keeps no menu that could
  take it from the page (the terminal's own chord, on Linux, lives in the page).
- **Links leave.** Jira, GitHub and Azure DevOps open in your browser rather than replacing the
  page.
- **The page's questions get asked.** Chromium draws `alert`, `confirm` and `prompt`; the app
  draws none of them itself, and every confirmation in Corvi — cancelling a change, a removal that
  would lose commits, deleting a leftover — behaves in the app exactly as it does in a browser.

Two details that took a bug each, and survive from the hosts this replaced:

- **It runs an interactive login shell** (`zsh -ilc` on macOS, your `$SHELL` elsewhere). A bundle
  launched from the Dock or a desktop entry inherits nothing, and `JIRA_API_TOKEN` and friends are
  exported from `~/.zshrc`, which a *non-interactive* login shell does not read. The server
  itself runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`), so Bun is not part of running the
  app (`docs/decisions/node-server.md`).
- **The root lives in the bundle's `package.json`** (`iweRoot`), not in the binary, so moving the
  repository is a reinstall rather than a rebuild. The port is nobody's to configure: the window
  picks a free one at launch.

Why Electron rather than the system's own web view: it is the same engine on both platforms, so
the window is developed and tested where it runs, and the capabilities the old hosts hand-built —
dialogs, notifications, microphone, links — are the engine's. It costs a Chromium in the bundle;
the trade is recorded in [docs/decisions/electron-host.md](docs/decisions/electron-host.md).

`app:install` **quits a running app and puts it back on the new build**: `open` on a running
application only focuses it, so a rebuild would otherwise leave you looking at the previous one —
a confusing ten minutes the first time it happens. On macOS it quits with an Apple Event rather
than a signal, so the app stops the server it started instead of orphaning it, and it builds to
one side first, so a failed build leaves the app you have alone.

Failures land in `~/Library/Logs/iwe.log`, and a server that never answers leaves the window
saying so rather than showing an empty page.

### On Linux

The same `app:install` puts four things in your home directory: a **desktop entry**
(`~/.local/share/applications/iwe.desktop`), **icons** rendered from `assets/icon.svg` into
`~/.local/share/icons/hicolor/<size>/apps/iwe.png` (skipped with a note if `rsvg-convert` is
missing — the app works without one), a **launcher**, `~/.local/bin/iwe-app`, with the repository
written in (`iweRoot`'s counterpart: moving the repository is a reinstall, not a rebuild), and the
built Electron window under `~/.local/share/iwe/app`. The port appears nowhere — the window picks
a fresh one at launch.

The window is the same Electron main as on macOS, so the dark first frame, dialogs, links to
Jira, GitHub and Azure DevOps, the microphone and notifications all come from Chromium rather
than from a second Python implementation (`docs/decisions/electron-host.md`). Without an Electron
binary in the checkout the launcher falls back to your installed Chromium's `--app` mode.

Lifecycle: clicking the icon (or running `iwe-app`) opens the window, which then manages the
server: it starts one of its own — on a fresh port, picked at launch, through your login shell so
`bun` and `JIRA_API_TOKEN` come from your rc file — and **closing the window stops the server it
started**. Terminals are tmux's and survive that, which is the same promise a restart of the
server has always made. The window records the pid of the server it started in
`~/.local/state/iwe/iwe-app-<port>.pid`, so `iwe-app stop` can still stop a server left behind by
a window that died harder than it could clean up after; it checks each pid is still an Corvi server
and refuses anything else. Logs land in `~/.local/state/iwe/log`. Without Electron the launcher
falls back to the browser's app mode, where the server is started detached and outlives the tab —
a browser window cannot clean up after anything. `app:uninstall` removes the entry, launcher,
icons and built window and leaves the logs alone.

## Installing it as an app

The page ships a web manifest and icons, so it installs as a standalone app — on macOS through
the browser, on Linux the desktop entry `app:install` writes plays that part:

- **Safari** — open the app, File → *Add to Dock*.
- **Chrome** — ⋮ → Cast, Save and Share → *Install page as app*.

Installed, the layout uses the full window (`@media (display-mode: standalone)`); in a browser tab
it keeps a readable 1200px column.

`http://127.0.0.1:4000` counts as a secure context, so no TLS is needed. The icon source is
`assets/icon.svg` (and `assets/icon-maskable.svg` for the padded, croppable variant); edit those
and run `bun run icons` to regenerate `src/app-root/icons/*.png` with `rsvg-convert`
(`brew install librsvg`). The generated PNGs are committed, so a clone serves them without it.

## Workspaces

A workspace is a **context**: a client, or your own projects. Configured, never discovered:

```json
{
  "workspaces": [
    { "id": "client", "name": "Acme" },
    { "id": "personal", "name": "Personal" }
  ]
}
```

The switcher sits at the top of the navigation column, above everything that belongs to it, and
filters the change list, the sidebar and what a new change is made in. `All work` shows
everything, which is a filter rather than a workspace and is set apart in the menu for that
reason. It is always shown, even with a single workspace: which context you are in should be
visible, not implied. And there is no such thing as no workspaces — a machine that has not
configured any gets one **Default workspace**, so the app works out of the box.

A change records the workspace it was made in (`"workspace": "client"` in `change.json`) — one
line, no directory moves, and moving a change between contexts later is one field. A change
recorded without a workspace belongs to the **first** workspace.

Two things it does deliberately:

- **A change is opened from the whole list, not the filtered one.** A link to a change in another
  context should open it, not report that it does not exist.
- **Nothing is listed until the workspaces are known.** A moment of "everything" before the
  filter arrives is a moment of another client's work on your screen, which is the one thing a
  workspace exists to prevent; the list says `loading…` for that moment instead.

The choice lives in the browser, not on the server: two windows open on two clients is a
reasonable thing to want, and the server has no business having an opinion about which one you
are looking at.

### What a workspace decides

```json
{
  "workspaces": [
    { "id": "client", "name": "Acme",
      "reposStart": "~/Repos/acme",
      "extensionSettings": {
        "jira": { "project": "PROJ", "configFile": "~/.config/.jira/client.yml" }
      },
      "extensionSettings": {
        "azure-devops": { "organization": "https://dev.azure.com/org", "project": "Project" }
      } },

    { "id": "personal", "name": "Personal", "extensions": ["git", "github"] }
  ]
}
```

The per-workspace organisation and project overrides live under
`extensionSettings.azure-devops` — the azure-devops extension's own business, read through the
`Workspace` tag. Which extensions a workspace has is the `extensions` list (below); a workspace
still carrying the retired names instead is migrated on load.

A workspace can also name **which extensions it has** (`"extensions": ["git", "github",
"github-issues"]`): the cards, wizard steps, pages, summary facts and hooks it gets at all.
Naming none means all of them; naming some is the whole list. Extensions are described in
[docs/guides/extensions.md](docs/guides/extensions.md) — the jira and github-issues extensions each
contribute a wizard step and a card, and both can be on at once: two tickets on one change is a
thing, not a conflict. A workspace still carrying a retired name is migrated on load — `ci` becomes `github` +
`azure-devops`, `deployments` becomes `azure-devops`, the `deployments` bags move to
`azure-devops`, and a legacy per-workspace `azure` object (`false`, or
`{ organization, project }`) folds into the same bag (`false` additionally materializing an
explicit list without `azure-devops`). The retired flat `azureOrganization`/`azureProject`/
`azureDeploy` fields stay readable through the extension's own fallback until that is removed.
The migration is automatic, for hand-edits and settings-page writes alike.

Extensions do not have to live in this repository: `"extensionPaths"` in the config (or the
`IWE_EXTENSION_PATHS` environment variable) names `.ts` modules or directories of them, loaded
at startup beside the built-ins through the same contract, with `~/.config/iwe/extensions/`
searched implicitly when it exists. A discovered extension's wizard step or page gets its
interface from a `client.tsx` beside the module, which the server builds and serves to the
page — see "Out-of-tree extensions" in [docs/guides/extensions.md](docs/guides/extensions.md).

**A second client is a second site.** `extensionSettings.jira.configFile` points at another
`jira init` — its own server, account and board — `extensionSettings.jira.tokenEnv` names the
variable holding that site's token, and `azure-devops`'s organisation/`project` are passed
to `az` explicitly rather than relying on its single configured default. Two clients can be open
at once.

### A second client is also a second login

```json
{ "id": "client", "name": "Acme",
  "env": {
    "GH_CONFIG_DIR": "~/.config/gh-client",
    "AZURE_CONFIG_DIR": "~/.azure-client"
  },
  "extensionSettings":
    { "jira": { "configFile": "~/.config/.jira/client.yml", "tokenEnv": "JIRA_TOKEN_CLIENT" } } }
```

`env` is added to **every** CLI Corvi runs for that workspace — `git`, `gh`, `az`, `tmux`, however
deep the call — so two GitHub accounts or two Azure tenants stop fighting over one login. `~` is
expanded, since these are paths and a shell would have done it.

The environment is carried through the request rather than threaded as a parameter: the
alternative is passing it through forty call sites that have no other reason to know about it —
`git status` does not care whose workspace it is in, it only has to run as the right one. A
request about a change enters that change's workspace; a request that is not about a change
enters the one the browser named; outside a request the environment is empty.

Which means **every cache key carries the context**: `az:<workspace>:runs:<ref>`,
`jira:<site>:keys:…`. Two organisations answering the same question differently is precisely the
bug this prevents, and it would have looked like "why is my personal change showing the client's
pipelines".

The browser sends the chosen workspace where the request is not about a change
(`/api/ext/azure-devops/services?workspace=…`, `/api/ext/jira/issues?workspace=…`); where it *is*
about a change, the change says which workspace it belongs to and nothing has to be passed.

## Navigation

One column, down the left, from the top of the window:

    Changes  New                     the overview, and starting one beside it
    ┃ Wait for the security review…  ▶     the changes still going; picking one opens its dashboard
    ┃ Anonymise customer names…       ▶
        >_ PROJ-1234                  its terminals, under the change they belong to
        >_ example-web - (pi working)

    Dashboard | Review changes       tabs on the change itself

A breadcrumb, a row of tabs and the terminal's own window strip would say where you are three
times and disagree about how. Everything you can go to is here, one level deep: **a terminal in
another change is one click**, not four.

There is no "Dashboard" entry, because picking a change opens it, and no "Terminals" heading,
because the icon on each row already says what it is. What is left is one flat list of
destinations. The change's two views — **Dashboard** and **Review changes** — are tabs on the
page instead, since they are two ways of looking at one change rather than two places to be.

Every change's windows come back from **one** call, `GET /api/terminals`: `tmux list-windows -a`
answers for every session there is, and the sessions that are not ours are dropped by their name.
Asking per change would be a process per change every few seconds.

A change is two lines — its id, then what it is about — with **a coloured bar down the left** for
its state, in the usual amber/purple/blue/green. A colour along the whole row reads from further
away than a dot does, and it leaves the icons to say what the *tools* are doing rather than what
you have decided.

One icon is left: a play button for the builds, coloured by the worst of them, from the same
`/api/changes/:id/summary` the overview cards use and refreshed every thirty seconds — this is a
glance, not a monitor. There is no terminal icon on a change, because its terminals are the rows
underneath and each says how it is doing itself.

**One thing is highlighted at a time.** On a terminal, that is the window — not the change it
belongs to, which stays plain until you are on its dashboard or its review tab. Two highlights
would be two answers to "where am I".

A terminal's icon is green while its window runs something and grey while it sits at a prompt.
**`>_ new`** appears only under the change you are working on: every change offering a terminal it
has not got would be more noise than help. On a change whose session has not started, it opens the
terminal — which starts one, with the window you were asking for.

**Opening a change starts nothing.** A terminal connects when it is opened, not when the
dashboard is: connecting on arrival left a tmux session — and a pty — behind for every change
you so much as looked at. A change needs no terminal at all some days.
The cost is that the first terminal of a change takes a moment to appear, which is the honest
price of not starting one behind your back.

The column is **resizable**: drag its edge, and the width is remembered in `localStorage`. The
whole edge is the handle, because that is what you aim at, and the drag is followed on the window
rather than on the handle, since the thing being dragged moves out from under the pointer.

The pages of a change appear only once a change is picked, and disappear again on the overview.
Each page keeps its own URL, so a deep link opens exactly what you linked to.

## Looking at the UI

```bash
bunx playwright install chromium   # once (webkit too, only for the other-engine run)
bun run shot                       # Chromium, into shots/
IWE_ENGINE=webkit bun run shot
```

Walks home → wizard → each step against `IWE_URL` (default `http://127.0.0.1:4000`) and reports
any console errors. Faster than describing a layout bug in prose.

**Chromium by default, because that is what the app is**: the window is Electron, and Electron is
Chromium (`docs/decisions/electron-host.md`). WebKit stays a variable away, because the page is a
web page first and Safari still opens it; `test/pages.test.ts` runs the page suite in Chromium by
default and takes `IWE_ENGINE=webkit` for that check.
and it still catches what Chromium tolerates (a missing route once came back as the app's own HTML
with a `200`, which WebKit words as *"The string did not match the expected pattern"*).

```bash
bun run app:permissions   # what this terminal may do to the app's own window
```

```bash
bun run app:run                             # the window, straight from the checkout
bun run app:drive                           # open it with Playwright and report what it did
bun run app:drive --shot --notify           # ... with a screenshot and a notification check
bun run app:sandbox 4090 --open             # a copy that cannot be mistaken for yours
```

**Never test against the installed app.** `app:sandbox` makes a copy with its own bundle
identifier, its own name and its own port, pointed at whatever scratch server you like. A copy
made with `cp -R` keeps the identifier `dev.iwe.app`, and `tell application id "dev.iwe.app" to
quit` then goes to whichever bundle the system resolves — which is how quitting a test copy quit
the real app instead, in the middle of somebody's work. Everything that addresses a bundle now
addresses a **path**, which is exactly one app.

`app:drive` opens the app's window through Playwright's Electron driver, so the window itself —
not just the page — can be checked without a human describing it: it reports the title, the URL
the window loaded, whether the host bridge is there, and any console errors, and it can take a
screenshot and exercise the host's notification path. It replaces the AppleScript that walked the
Swift app's accessibility tree; it needs no Accessibility permission, and it runs on Linux too.

The page is driven by Playwright (`bun run shot` and the suite); the parts that are not the page —
the title bar, the Dock icon, a notification banner — can only be checked by looking at the real
thing, and macOS gates screenshots and clicking behind permissions granted per application.
`bun run app:permissions` reports where those stand.

## Jira over its own API

`src/extensions/jira/jiraHttp.ts` is the whole transport: read the config `jira init` wrote, basic
auth with `JIRA_API_TOKEN`, and one `fetch`. `src/extensions/jira/jira.ts` is the integration on top
of it — sprints from `/rest/agile/1.0/board/<id>/sprint`, issues from that board's sprints and
from `/rest/api/3/search/jql`, transitions from `/rest/api/3/issue/<key>/transitions`.

Talking to the REST API directly means one process for the whole board rather than one per call,
and JSON rather than CSV — a format `jira-cli`'s plain mode could not even produce unambiguously,
since it pads columns with the delimiter.

Two things that only the API can do, and both matter:

- **Transitions are asked for, not guessed.** `jira issue move KEY Done` fails with "transition
  not found"; the API lists what is legal from where the issue is now, so a wrong status says
  `cannot move to "Done" from here — available: To Do, In Progress`. A silent failure here is
  what leaves a change merged with its ticket still open.
- **Fields come back as fields.** No quoting rules, no column positions, and `assignee` is null
  rather than an empty column that might be a comma.

The config file is read without a YAML parser: it is a megabyte of custom-field schema and four
scalars at known depths (`server`, `login`, `board.id`, `project.key`). A parser would be a
dependency and a lot of code for four values.

Descriptions are sent as an Atlassian document (`{type: "doc", version: 1, ...}`), which is what
v3 takes instead of a string.

## Opening a repository

Every repository row in **Local changes** has a ⋯ menu: **Open in IntelliJ** and **Open in
Finder** (on Linux, **Open in Files** — the desktop's file manager). macOS opens through `open`,
by application name; Linux goes through `xdg-open`, with IntelliJ via its `idea` launcher script,
which only offers the menu item when it is on the path. IntelliJ receives the project rather than being launched again, so where it lands — new
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

The list may also be emptied. A change with no repositories is not much of a change, but it is a
step on the way to one: taking a repository out and putting it back is how you get a fresh
worktree when the one you have is beyond saving, and refusing the empty middle made the whole
manoeuvre impossible. Creating a change still needs at least one — that is a decision about what
the work *is*, not a step in the middle of it. What a removal protects is unchanged: uncommitted
work refuses outright, unpushed commits ask first.

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

When the branch below has a pull request of its own, Corvi also registers the two as a **GitHub
stack** (a public preview feature): the new pull request is appended to that stack, or a stack of
the two is created. Reviewers then see the order of the work, and merging the bottom one carries
the rest along. It is best effort — a repository without the preview feature, or a base branch
with no pull request, simply gets the correct base and nothing more.

Stacking is worth avoiding when you can simply wait for the change below to merge; two deep is
manageable, four is a research project every time the bottom one moves.

### What a new worktree inherits

A worktree is a checkout of the same repository, but to IntelliJ it is an unknown directory: no
`.idea` means the project is imported from scratch, and no `.bsp` means there is no build server
to import it with. So on creation Corvi copies those directories over from the repository —
`worktreeCopy` in the config, by default:

```
.idea  .bsp  .bloop  .scala-build  .metals  .vscode
```

**Only what the new worktree ignores is copied.** A worktree that does not ignore `.idea` gets an
untracked directory the moment it is made, and that is not cosmetic: it counts as dirty for ever,
so it cannot be removed, and the review tab offers our copy of somebody's IDE settings up for
committing. The question is asked of the worktree rather than of the repository it came from,
because they can disagree — a worktree branches from the remote default, which may not carry the
`.gitignore` your checkout has.

**The paths inside them are rewritten** to the new location, which is the whole point: a `.bsp`
copied unchanged points its build server at the main checkout, so the IDE would show you one
directory and compile another. Rewriting is careful about where a path is a path and where it is
only a prefix — `example-api` must not be rewritten inside `example-api-client`, and that is not
hypothetical: one repository here has a sibling's `bin` directory on the `PATH` in its
`.scala-build/ide-envs.json`, and a naive replacement corrupts it.

None of this is Corvi's state and none of it is in git; it is ignored, per-machine, and written by
other programs. It is copied once, at creation, and never touched again — a worktree that already
has a `.idea` keeps it, since the IDE has owned it since. Build outputs (`target`, `node_modules`)
are deliberately *not* copied: recreating them is a build, and a stale copy is worse than none.
Failing to copy is never fatal — the worktree is what was asked for.

`reposStart` in the config sets the directory the browser opens on; `↑ Up` still walks back to
`reposRoot`.

## Terminals

Each change has a **Terminals** tab: one tmux session named `iwe-<change id>`, started in the
change directory on Corvi's own tmux socket (`-L iwe`), attached by a pty in the server
(`node-pty`) and drawn by xterm.js in the page itself.

A terminal outlives the server: tmux owns the session and the pty is only one of its clients, so
restarting Corvi — which is constant while working on Corvi itself — detaches and re-attaches without
costing you a shell. Completing a change is what ends a terminal for good.

The connection is made when a terminal is opened, and not before: a dashboard you glanced at
should not leave a session behind. The dashboard cards are unmounted while a terminal is in front —
otherwise their per-repository calls, which occupy every connection the browser allows per
origin, starve the window list's polling. Returning to the dashboard repaints from the cache and
refreshes.

The session's windows are listed in the navigation column, labelled by **where they are** — the
directory of the pane, which is the repository you are in — with **what is running there** in
brackets after it: `example-api`, `example-web - (vim)`. A plain shell adds nothing, so it is
left out. Rename a window (`ctrl-b ,`) and your name replaces the directory, because tmux stops
renaming it for you at that point and so do we.

A window running a **coding agent** says what the agent is doing — `example-api - (pi working)`,
`example-api - (pi waiting)` — instead of `node`, which says nothing. The agent reports that
itself, in the `@agent_status` **tmux pane option**, which the agents extension's presenter reads out
of the same `list-windows` call as everything else. The overview believes it over the process
waiting for you is not work in progress, though its process is very much running.

`pi/agent-state.ts` is that reporter for pi — `agent_start` sets `@agent_status working`,
`agent_settled` sets `waiting`, `session_shutdown` unsets it. Settled rather than ended, because
after `agent_end` pi may still retry, auto-compact or pick up queued messages, none of which are
"waiting for you".

```bash
bun run extension:install     # symlinks it into ~/.pi/agent/extensions/
bun run extension:uninstall
tmux display -p '#{@agent_status}'   # what the pane you are in says about itself
```

A symlink rather than a copy, so editing it here is editing the installed one and `/reload` in pi
picks it up; the script repoints whatever symlink is there, so installing from another branch or
worktree moves it, but leaves a real file at that path alone.

A pane option rather than the terminal title, because the title is shared: pi rewrites it
whenever the session name changes — right after a run, when it names the session from your first
message — and the shell rewrites it between commands, so a marker there would keep vanishing
seconds after it appeared. Nobody else writes `@agent_status`, and tmux drops it when the pane
dies, so a crashed agent leaves nothing stale behind. The option is read from each window's
**active pane**, so an agent left in the inactive half of a split is not seen.

A dot marks a window whose output arrived while you were looking elsewhere, and the strip's **new**
tab — or **cmd-t** (`ctrl-alt-t` on Linux, where the meta key is unreliable) — opens another. The
navigation column lists the windows a change has and nothing else: adding one is the strip's, right
there beside the ones you already have.

A new window starts **where the current one is**, not back in the change directory: a new tab is
almost always "the same place, another thing", and `#{pane_current_path}` is what tmux's own
`ctrl-b c` binding uses anyway. cmd-t works from inside the terminal too, where the keyboard
usually is: the injected key script cannot open a window itself, so it forwards the key to the
page around the frame. In a browser tab Chrome keeps cmd-t for itself; installed as an app it
reaches us — on Linux the chord is ctrl-alt-t for the same reason, and it works in a browser tab
too. The keyboard stays in the terminal throughout: the navigation column's entries refuse
the focus a mousedown would give them, and opening a terminal focuses it, so you can type straight
away. tmux stays the source of truth — the page calls `list-windows`, `new-window` and
`select-window`, so the keys keep working and a session attached from a terminal stays in step.

Windows and panes are yours to make with the usual tmux keys — the **tmux cheat sheet** button in
the terminal's own row lists them — which is also the answer to "how do I get more than one terminal":
tmux does that, Corvi does not duplicate it. Mouse mode is switched on for the session, so the wheel scrolls the
pane instead of walking through shell history; it is set with `-t`, so tmux sessions you started
yourself keep your own settings. A change needs no terminal at all some days and three in one
repository on others, so Corvi opens none for you: opening the terminal is what starts the session.

**Shift-Enter and Ctrl-Enter.** A browser terminal cannot encode these by itself: xterm.js sends a
carriage return for Enter whatever modifier is held — there is no legacy encoding for a modified
Enter, and it implements neither of the modern ones. So the page sends the CSI u sequence
itself instead (`ESC [13;2u` for shift, `;5` for
ctrl, `;6` for both). tmux is started with `extended-keys on`, which passes those through to
applications that ask for them — which is what an application means when it says *"tmux
extended-keys is off. Modified Enter keys may not work."*

Shift-Tab has always worked because it *does* have a legacy encoding (`ESC [Z`), which is the
difference between the two keys.

Copying out: the mouse belongs to tmux while mouse mode is on, and tmux hands its own copies to
the page as an OSC 52 sequence, which the terminal writes to the system clipboard — so a plain
drag (and a **double-click** for a word, a triple-click for a line) is all it takes; the tmux
buffer is separate (`ctrl-b ]` still pastes it). The browser's selection is one modifier away:
**option**-drag on macOS, **shift**-drag on Linux — the modifier xterm.js honours on each
platform, and the terminal turns on `macOptionClickForcesSelection` for the Mac one. On macOS
the browser's own shortcut copies that selection (**⌘C**; the app's Edit menu routes it, as
AppKit did). On Linux there is no menu to route a clipboard shortcut and Ctrl+C belongs to the
shell, so the page takes **Ctrl+Shift+C / Ctrl+Shift+V**, and **middle-click** pastes the
clipboard too; the cheat sheet button lists the keys for the platform you are on.

A terminal that comes up blank: the session is reachable from a normal terminal
(`tmux -L iwe attach -t iwe-<change id>` — the sessions live on Corvi's own socket, so the command
has to name it), which tells you quickly whether the problem is tmux or the browser. After
changing the manifest, reinstall the app — Chrome keeps the old one otherwise.

The socket is also what keeps a stray `tmux` command from reaching Corvi: a bare `tmux` — from a
script, a probe, a test run — resolves to the default socket and finds none of these sessions.
Inside a pane, though, `$TMUX` still names Corvi's server, so a `tmux kill-server` typed there ends
every Corvi terminal; outside a pane it finds nothing.

Completing a change kills its session and the ptys attached to it, since the change directory
moves into the archive underneath it.

## Review changes

The change's second tab: everything uncommitted across it on the left, the diff of whatever you
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

**Commit…** opens a dialog over the whole change: one message, one commit per repository that has
something ticked. A change is one piece of work, and which repository a file lives in is where the
code happens to be kept — writing the same message twice is a chore the tool should not ask for.
The message starts as `<id> <the change's name>`, which is what people write anyway.

What is ticked is what is committed: `git add -- <paths>` so untracked files and deletions are
recorded, then `git commit -- <paths>` so **only** those paths go in. Anything else you had
staged stays staged. Committing the whole index because you happened to open this dialog would
be a surprise, and the surprising half would be invisible.

The ticks start from what is already staged, or from everything when nothing is — the two
readings of "I know what I am committing". A repository that refuses says why and does not stop
the others: half a change committed is a normal state to be in.

**Push** appears beside it when there is something to push, and says how much: `Push 2`. It
pushes every repository that has commits the remote has not, with `-u`, because the first push of
a change's branch is also where that branch comes into existence on the remote.

A branch with no upstream is not "0 ahead" — everything on it since it left its base branch is
unpushed, and that is what the button counts (`git rev-list --count <base>..HEAD`). Once it is
tracking, the count comes from porcelain v2's `# branch.ab` header, which the status call already
returns. A repository line says both: `1 change, 2 unpushed`, so a clean repository that is only
clean because the work is sitting in local commits does not read as finished.

Unstaging and discarding are still missing, and both destroy work when they are wrong, so they
want more care than a click.

## Notes

Each change has a free-text note, a **Notes** card on the dashboard when the notes extension is
enabled, stored as `extensions/notes/notes.md` in the change directory so it travels into the
archive with everything else. A note written before the widget existed, at the change root's
`notes.md`, still shows as a read-only fallback. It saves shortly after you stop typing, on blur,
and when you navigate away.

## Left behind

A page of its own, beside `Changes` in the navigation column when the leftovers extension is
enabled: the directories in the changes root that no longer belong to a
change — what a completed one left behind (a build's `target/`, a shell's history, the terminal's
note) or a change that was never finished being created. Each one opens to show what is in it,
with its size, and a Delete button. Nothing is removed on your behalf: `target/` is rubbish, the
scratch file next to it might not be.

Deletion refuses anything that still has a `change.json`, so an active change cannot be tidied
away by accident, and the archived copy of a completed change is untouched — only the directory
that outlived it goes.

Directories inside a leftover are labelled when git cares about them: `git worktree` for one still
registered with its repository, `git repository` for a clone with a history of its own. Both are
named in the confirmation, and after deleting a worktree the repository is pruned, so git does not
keep a registration for a path that is gone.

## The order things are listed in

Active changes, in the navigation column and on the overview, are sorted by **state first and then
newest first**:

```
Ideation          ← an idea, not started
In Progress       ← what you can get on with
Awaiting Review   ← what is with somebody else
Blocked           ← what is stuck
```

That is `CHANGE_STATES` itself, so there is one order and it is used twice: the state select
offers them in it, and the lists sort by it. Within a state the newest change is on top, because
that is the one you are most likely to be looking for.

Ideas are the one place that order is not read straight down: the overview and the navigation
column put them in a block of their own at the top, under an **Ideas** heading, because an idea is
a question where the rest is a job. `Ideation` still ranks first in `CHANGE_STATES`, so the block
and the order agree.

Finished changes — completed and cancelled — go to a table below, newest first, with a column
saying which of the two it was. A change that was abandoned is not one that landed, and that is
the first thing you want to know about a row down there.

`Settings` sits at the bottom of the navigation column rather than under the list: it is where you
go once in a while, and it should be in the same place whether you have two changes or nine.

## The overview

The front page is three lists, because they are read for different reasons: ideas you have not
started, work in flight, and what happened.

A change is named by **its ticket's summary** — "Anonymise customer names on the acceptance
environment" — rather than its branch, which says how the work is spelled and not what it is. A
change without a ticket shows its branch instead, in monospace, since that is an identifier and
reads as one.

The summary is stored in `change.json` the first time it is read, so the list carries it and the
page is complete the moment it loads; `GET /api/titles` then refreshes every change on the page
in **one** `jira` query and writes back what changed. A Jira that answers nothing — down,
unauthenticated, ticket deleted — leaves the stored name alone rather than falling back to a
branch nobody recognises, and an archived change keeps its name for good.

**The name is editable**: rename it from the Actions menu in the change's own row, which opens a
field for it beside the state. It is not in the window's own row, which says nothing about the
change at all. Type over it and it stops being refreshed from Jira. Renaming sets `titleEdited`,
and a change with that set is not asked about again — its ticket is left out of the query entirely,
so nothing overwrites your words later. Clearing the field hands the name back to Jira.

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

## Azure DevOps

A page of its own, beside `Changes` in the navigation column: one row per service, one column per
environment, and what each of them holds.

    SERVICE                ACCEPT                          PRODUCTION
    example-service        ● 20260827_072639_9a38834  4d ago  ● 20260827_072639_9a38834  4d ago
    example-app          ● 20260824-082948-bbba9816 8d ago  ● 20260811-085715-2a8503e7 20d ago

**Not part of a change, deliberately.** You deploy a service's build to an environment, and which
change produced that build is a separate question — often somebody else's. "What is on accept?"
is asked before a release and during an incident, when there is no change open to ask it from.
This is the first part of Corvi that is not about a change, and it is the exception that earns it.

**Nothing is stored.** A deploy run records the version and the environment it was given
(`templateParameters`), so the newest run per environment *is* the state of that environment, and
Azure DevOps is the one keeping it. A record of our own would be a cache of something
authoritative, and would be wrong the moment somebody deployed from a terminal.

The newest run wins even when it failed or is still running: a red deploy is news, and hiding it
behind the last success would say the environment is fine while somebody is staring at a failed
pipeline. A failed deploy leaves the previous version running, so the row shows that version and
says the newer one failed.

A row whose environments differ is marked in the margin — production behind acceptance is the
normal case, and how far behind is the point of looking.

The version parameter is not called the same thing in every pipeline (`dockerTag` here,
`imageTag` for the app), so the configured name is tried first and, failing that, the only other
parameter there is: a deploy run takes the environment and the thing to deploy, and when those
are the only two, which is which is not a guess.

Configured under the azure-devops extension's own settings — `extensionSettings.azure-devops`
on the settings page, or by hand — because none of these names are ours:

```json
{
  "extensionSettings": {
    "azure-devops": {
      "pipeline": ["build-", "deploy-"],
      "versionParameter": "dockerTag",
      "environmentParameter": "environment",
      "environments": ["accept", "production"]
    }
  }
}
```

The retired flat `azureDeploy` field is still read from the file when the bag does not
answer — its defaults and the `IWE_AZURE_*` environment variables included.

**Deploy…** opens a dialog: which version, and where to. The versions are the service's own recent
builds, newest first, each with the version it produced — scraped from the build's logs, because
Azure records it nowhere else — the build number, the branch it came from, **when it finished**,
and where that version already is.

    20260828_081445_03798b3  2026-08-28 10:15  on accept and production      20260828.2 · main
    20260828_043219_ec6405e  2026-08-28 06:32                              20260828.1 · PR #207

What it is and how far it got on the left — version, when it finished, where it already is, the
last of those coloured green once it has reached the final environment and amber while it is only
part of the way. Which build it came from on the right, where it is available when you want it
and out of the way when you do not.

The timestamp is there because a version string is not something you can check against your
memory of what you merged, and a time is: "the one from just after lunch" is how people actually
identify a build. On the table the same time is a hover away, where the column says `4d ago`.

A row whose environments differ also offers the promotion it is asking for directly:
`Promote to production`, with the version and environment filled in.

**A later environment only gets what the one before it already has.** Choosing a version that is
not on acceptance says so before you click, and the server refuses it as well — the button is a
convenience, the rule is not. This is the manual step of the shell script this replaces, where
you read the acceptance logs yourself and decided; here the acceptance *run's own result* decides.

Two more things the dialog does deliberately:

- **It reads the versions when it opens**, not from the row behind it. A row is up to thirty
  seconds old; this is the decision, not the display.
- **The last environment's button is red**, and says what it will do rather than "OK":
  `Deploy 20260901_124345-8356c0c8 to production`.

The version parameter is learnt per pipeline from what that pipeline was given last time, so a
service that calls it `imageTag` is deployed with `imageTag` without anybody configuring it.

## Cancelling a change

The other way a change ends, in the same menu as `Complete change`:

```
Cancel change    → the worktrees and the terminal go
```

Nothing anyone else can see is touched. The pull requests stay open, the ticket stays where it is,
and the branches stay wherever wt left them — cancelling is a decision about your own desk, and
closing somebody else's pull request or moving a ticket other people are watching is a decision
about theirs. What is left over is listed when it finishes:

```
Cancelled. Still open: PROJ-123 is still open in Jira; example-api #12 is still open;
the branch PROJ-123-work is kept in example-api
```

The branch line is worked out **after** the worktrees are removed rather than promised in advance,
because wt keeps a branch that has commits nobody else has and removes one with nothing on it.
That is the behaviour you want and not the one you would guess, so it is reported rather than
claimed either way.

The protections are a repository removal's, because it is the same act: **uncommitted work
refuses outright** (it exists nowhere else, and no dialog makes it recoverable), and **commits
that were never pushed ask once** (the branch survives, so they are recoverable — by someone who
knows the branch is there). The asking happens in a dialog rather than a `window.confirm`:
the first click opens it, confirming runs it, and a 409 naming the repositories fills in the
one acknowledge. The change is archived as `Cancelled`, and stays readable: what was
abandoned is worth being able to look up.

### After it ends

A finished change — completed or cancelled — keeps its dashboard, without the buttons. Its
worktrees are gone and its directory is in the archive, so `Create worktree` and the rest offer to
half-revive something that is over; the rows stay, because what a change touched is worth reading
afterwards, and so does the `⋯` menu, because opening one of its repositories still makes sense.
The action route refuses too, with a 409: the page may have been open since before the change
ended, and the server is where the truth lives.

## Change state

Every change carries one of `Ideation` (teal), `In Progress` (amber), `Awaiting Review` (blue),
`Blocked` (purple) or `Completed`/`Cancelled` (green/grey). The states you work in are chosen in
the select beside `Complete change`; `Ideation` is not one of them. It is set by creating an idea
and left by **Start work**, which is an action rather than a word in the list because starting
does more than change a label: it creates each repository's checkout and moves the ticket.

`Blocked` is waiting on something you cannot do yourself: an answer, a decision, another change.
That is a different thing from `Awaiting Review`, which is waiting on a named person to look at
work that is done, and the distinction is worth a colour because one of them is your problem to
chase and the other is not.

The state is kept by hand rather than derived, because the tools disagree often enough (a merged
pull request with the ticket still open, a review that happened in a call) that your own answer
is the useful one. Completing a change sets it to `Completed`. A change recorded without a state
reads as `In Progress`.

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

The readiness check runs before anything is written: a change that is not ready is a dialog (or,
forced, an error), not a completion that started and stopped, so no journal is written for it.
Once it will run, the check step is recorded first — it is slow, and a page that just asked for a
completion should see something at once.

The card stays for completions that finished, so an archived change still shows what was done and
when. A change that was never completed has no card. A completed change does not start a terminal: doing so would write into a directory
that has just moved to the archive, and the change would then be listed twice, once under each
name. It is listed once regardless, since a leftover directory (a build's `target/`, a shell's
history) is not a second change.

`Complete change` on a dashboard squash-merges every outstanding pull request and moves the Jira
issue to `jiraDoneTransition` (default `Done`), then records `completedAt` in `change.json`.

The button is always available; the requirements are checked when you click it, against
freshly fetched refs. Ready completes as above. A review only blocks when the repository
requires one: `REVIEW_REQUIRED` (a required review is outstanding) and `CHANGES_REQUESTED` (a
reviewer asked for changes) refuse, while no review decision at all means the repository
requires none, and the pull request merges as it stands. Not ready opens a dialog listing each
unmet requirement, one acknowledge each: completing anyway skips what is unmerged (pull requests
that are not merged stay unmerged, unpushed commits stay on the branch) and records the
overrides in `completion.json` and the **Completing** card. Uncommitted work and an idea
refuse outright, even with force — the first exists nowhere else, the second is left by
starting, not by completing. Merges run sequentially: if one fails, the ones after it have
not happened.

A branch whose content already landed in main — merged through a pull request created
elsewhere, or pushed straight to it — reads as merged without a pull request here: either
main contains the branch outright, or it holds patch-identical copies of every commit (what
a squash merge leaves behind). Only when there is no open pull request asserting "under
review"; an open one still gates, overridable through the dialog.

Squash is the only merge method both repositories allow, and they delete the remote branch
themselves. Once the merges succeed the local worktrees hold nothing the remote does not, so they
are removed and the change directory is moved to `~/changes/archive/<id>/`. Archived changes are
still read, written and listed exactly like active ones.

Completion is therefore also refused when a worktree has uncommitted changes, even if the
pull request is approved: removing it would throw that work away. Unpushed commits ask
instead — the branch survives the worktree removal, so they are recoverable by someone who
knows the branch is there — through the same per-requirement dialog. Hovering the menu item
shows the last poll's verdict; the click re-checks, so the hover is orientation, not the
decision.

## Routing

`/` lists changes, `/new` is the wizard, `/azure-devops` is the Azure DevOps page, `/settings` is
the settings page, `/changes/<id>`
is a dashboard, and `/changes/<id>/review` and `/changes/<id>/terminals` are its other two pages. Navigation uses
`history.pushState`, the server serves the app for any non-`/api` path, so deep links, reload and
the browser's Back button all work.

## Pushing instead of polling

`GET /api/events` is one `EventSource` per tab. The server watches, and says when something
changed:

```
event: changes     the change files moved — created, renamed, finished, repositories edited
event: windows     tmux has different windows than it did
```

Polling would have every open page ask for the terminal windows every 1.5 seconds and the changes
every 30, against a browser limit of six connections per origin — the limit that forces the
dashboard's widgets to be unmounted rather than hidden while a terminal is on screen. Instead the
server looks once, on one timer, for everybody.

**Events carry no data.** They say that something changed; the page then asks for it through the
same cached routes as everything else. That keeps this small — no second way to fetch anything,
no state to keep in sync — and means a missed event costs one refresh rather than a screen that
disagrees with the disk.

Three things it has to get right:

- **The watcher stops when the last page goes.** A process quietly reading the disk and asking
  tmux twice a second for a browser that was closed this morning is a bug you never see. Clients
  are forgotten on the request's abort signal — the stream's own `cancel` is not called when a tab
  closes, so the signal is what removes them.
- **What was last seen survives a disconnect.** Without it the first look after every reconnect
  is silent, which swallows anything that changed while nobody was listening.
- **A quiet stream still has to say something.** Bun closes an idle connection after ten seconds,
  and an event stream is idle by definition. The browser reconnects, so it half-works: a drop and
  a reconnect six times a minute, for ever, with `request timed out` in the log each time. There
  is a heartbeat every five seconds, and `idleTimeout` is raised as well.

Routes that change something announce it themselves, so your own action lands at once rather than
within a tick. That is an optimisation, not the mechanism: the watcher would find it anyway, which
is why a `git` command in a terminal or a hand-edited `change.json` shows up too.

## Caching

Everything on a page costs a subprocess, and the same answers are wanted by the overview, the
dashboard and the summaries within seconds of each other. `src/capabilities/cache.ts` is one
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
edit `bun --watch` cannot take — and without it every page waits for the CLIs all over again.
Entries older than six hours are not restored: a page painted from yesterday's builds is worse
than a page that waits.

Subprocesses are bounded at eight at once (`IWE_PARALLEL`), and a CLI that has not finished
within two minutes (`IWE_CLI_TIMEOUT`) is killed and reported as a failed command. A dashboard of six repositories asks
about thirty things in parallel, and `az` is a few hundred milliseconds of CPU each; queueing
them costs nothing in wall time and keeps the machine usable while it happens.

## The cost of a refresh

The dashboard is CLI calls, and they are not all alike. `IWE_TRACE=1` counts them and adds up
what each tool costs; measured on a six-repository change, one refresh is **60 processes and 6
seconds of CPU**. What keeps it cheap:

- **Worktree state is read with git, not `wt list`.** `wt list` gathers CI, diffs and summaries in
  parallel and costs 1-13 seconds of CPU per call; `git worktree list --porcelain` plus
  `git status --porcelain=v2` costs ~25ms and answers everything the card shows. wt still creates
  and removes worktrees — it owns where they live.
- **Azure DevOps calls are shared.** `az` is a Python program, a few hundred milliseconds of CPU
  per invocation, and every repository of a change asks about the same branch at the same moment.
  Pipeline definitions are held for five minutes, runs for ten seconds, and calls in flight are
  shared outright.
- **`origin/HEAD` is asked once per repository.**

The rest is network-bound rather than CPU-bound: `gh` and `jira` are Go binaries that spend their
time waiting.

## Dashboard loading

The page renders immediately: `GET /api/changes/:id` returns the change with no CLI calls, and
each component is fetched separately.

Every card cancels its requests when it goes away. Without that, the ten-odd slow per-repository
requests of a big change keep saturating the browser's six connections per origin (HTTP/1.1 on
localhost, so no multiplexing), and the next page waits seconds for a free one: measured at
2387ms for `GET /api/changes` mid-load versus 4ms idle.

Widget data is kept in a small in-memory cache in the browser (`src/app-root/cache.ts`), keyed by
change, component and repository, so leaving a change and coming back paints the last known rows
straight away while they refresh in the background. A page reload starts empty.

Components that work per repository (Local changes, CI) declare `repoStatus` instead of `status`,
and the browser fetches `GET /api/changes/:id/:card/repo?path=…` once per repository. The
rows appear one at a time as each repository answers, so a change with many repositories fills in
progressively instead of staying empty until the slowest CLI call returns. Everything refreshes
every 15s, and a slow or broken CLI delays only its own row.

## Adding an integration

Write an extension (see [docs/guides/extensions.md](docs/guides/extensions.md)): a module whose default export
**describes** what it contributes — `cards`, `wizardSteps`, `routes`, `pages`, and the rest of
the surfaces in docs/guides/extensions.md. A card takes the same shape the integrations always had —
`status(change)` for a whole widget or `repoStatus(change, repo)` to be fetched a repository at
a time — and the UI renders whatever widgets come back; a card needs no frontend change. A
wizard step is `wizardSteps` plus a React component in the extension's `client.tsx`, and
`events["change:created"]` is the creation hook. A built-in is added to the loader in
`src/extension-host/index.ts` and, when it has a step, a page or a change tab, to the client registry in
`src/extension-host/client.tsx`; an out-of-tree one is added to `extensionPaths` in the config instead
and registers nowhere.

## Tests and your real changes

`bun run test` sets `IWE_ROOT` to a directory under `$TMPDIR`, so no test run can write into the
changes root you actually use. This is a safety net rather than the rule — test files set their
own root — because a test that does not would write into your real `~/changes`: `setRepos`
accepts an empty repository list and writes before it can notice, so `test/provision.test.ts`
would otherwise create a `PROJ-1` there.

## Testing the terminal

`test/terminal.test.ts` drives the real thing: it starts a server on a temporary root, opens the
Terminals tab in Chromium, types `pwd > out.txt` into the xterm.js pane and reads the file back,
then checks `ctrl-b c` reaches tmux, mouse mode is on, that tmux's own copy and the page's
chords reach the system clipboard, that a second page keeps the session, and that the shells
survive a server restart. It skips itself when `tmux` or Playwright's Chromium is missing rather
than failing.

## The page tests

`test/pages.test.ts` opens every route, round-trips the settings page and pins the notes card's
layout — in Chromium, because that is the engine the app renders in (the window is Electron,
docs/decisions/electron-host.md). `IWE_ENGINE=webkit bun test test/pages.test.ts` runs the same
file in Playwright's WebKit where its bundle starts (natively on macOS; on Linux only where its
Ubuntu-built libraries match), which is the browser-side check for Safari; it skips rather than
fails when the chosen engine cannot launch.

The route sweep earned its place when the app was WebKit: it found the dashboard firing a
readiness check that answered `400` when there is no GitHub remote, which the page swallowed —
the menu item was disabled with nothing to say. That is now a reason like any other ("cannot
complete: …"). The podman harness that forced a WebKit run (`Containerfile.webkit`,
`bun run test:webkit`) is gone with the app's WebKitGTK dependency.

## Layout

The layers, and the rule for where a feature's code lives, are in
[docs/guides/architecture.md](docs/guides/architecture.md). The documentation itself is indexed at
[docs/README.md](docs/README.md): `docs/guides/` is durable, `docs/decisions/` records why a
choice was made, and `docs/plans/` holds active work only.

The map, grouped by layer:

    src/server.ts             node:http: /api/*, /api/ext/:name/* dispatch, SSE, the terminal socket

    src/capabilities/         the substrate everything stands on
      effect/                 errors (the taxonomy) · http→status · runRoute · Workspace tag ·
                              support.ts (the shared shSoft/cliJson/messageOf/fs helpers)
      shell.ts                the subprocess gate, timeout and trace
      cache.ts                stale-while-revalidate for everything the CLIs answer
      bus.ts                  the SSE hub and the watcher behind it
      web.ts                  refusing requests another site made, and the HTTP helpers
      os.ts                   platform detection and IDE state carried into a new worktree
    src/vendors/              vendor CLI wrappers shared by more than one feature
      git.ts                  worktrees and checkouts (wt, plus plain git)
      github.ts               pull requests, review threads, merges
      github.ts               pull requests, review threads, merges
      stacks.ts               stacked pull requests

    src/change/               the change module: its server half and its shared rule, no UI
      model.ts                applyPatch: the two fields you may edit by hand
      server/                 schema.ts (the change.json schema), store.ts (change.json, the
                              archive, sidecars, ExtensionStore files), create.ts, complete.ts,
                              cancel.ts, titles.ts, description.ts,
                              index.ts (the public face)
      routes.ts               its HTTP table
    src/dashboard/            the dashboard tab
      server/                 summary.ts (composes change, terminal and the host),
                              index.ts (the public face)
      client/                 WidgetCard.tsx, WidgetRows.tsx, PerRepoCard.tsx, CompletionCard.tsx,
                              EditReposDialog.tsx
      routes.ts               the change's summary endpoint
    src/change-page/          the change shell: composes the dashboard, extension tabs and the
                              terminal; owns no data
      client/                 ChangeView.tsx, changeTabs.ts
    src/wizard/               /new: Wizard.tsx, index.ts (the face)
    src/terminals/            the terminal module: sessions without change knowledge
      server/                 tmux.ts (sessions and windows), session.ts (the pty and the
                              socket bridge), presenter.ts (the window merge and the core's
                              defaults), index.ts (the public face)
      client/                 TerminalPane.tsx, WindowTabs.tsx, CheatSheet.tsx
      routes.ts               the terminal socket, the windows and the prompt API
    src/workspace/            the workspace module: contexts, config and the repository browser
      server/                 config.ts (config file + env overrides), schema.ts (the config file
                              schema), workspaces.ts (which context a change belongs to),
                              repos.ts (directory browsing under reposRoot, remote branches),
                              index.ts (the public face)
      client/                 workspaces.ts (the context switcher state), WorkspaceCard.tsx,
                              RepoBrowser.tsx
      routes.ts               the repo browser and the workspaces list
    src/settings/             the settings module: the settings file, read and written from the page
      server/                 settings.ts (the page's read/write surface), legacySettings.ts (the
                              one precedence chain), index.ts (the public face)
      client/                 SettingsPage.tsx, SettingsFields.tsx
      routes.ts               the settings file route

    src/domain/               the vocabulary the server and the page share —
                              change.ts, widget.ts, terminal.ts, time.ts, config.ts
    src/extension-host/       the extension contract and its machinery — api.ts (api/*.ts),
                              registry.ts, discover.ts, selectors.ts, effects.ts, dispatch.ts,
                              services.ts, clientChunks.ts, vendor-jsx.ts, client.tsx (the page's
                              client-side registry and the extension UI contract), index.ts,
                              routes.ts (wizard, pages, ext dispatch, card/tab endpoints,
                              extension client and vendor chunks)

    src/extensions/           the built-ins, and nothing else
      agents/ git/ github-issues/ jira/
      github/                 the GitHub card, and checks.ts (the pull request's checks)
      azure-devops/           index.ts, pipelines.ts (the per-change facts), server.ts (the page's
                              implementation), client.tsx, DeployDialog.tsx,
                              deploySettings.ts (the extension's own settings, read back),
                              azure.ts (which Azure DevOps is meant), legacy.ts (the retired
                              fields, read back), migrate.ts (the retired names, folded away),
                              deployConventions.ts (the pipeline-name convention both halves share)
      leftovers/              index.ts, server.ts (the implementation), client.tsx, shared.ts
                              (the Leftover type both halves read)
      notes/                  index.ts (the Notes widget), server.ts (the store-backed read and write),
                              client.tsx
      review/                 index.ts (the declaration and routes), server.ts (the git surface),
                              client.tsx (the change tab), LocalPane.tsx, CommitDialog.tsx,
                              shared.ts (the vocabulary both halves read)

    src/app-root/             the browser shell and runtime, bundled by Bun's HTML import
      app.tsx                 shell, changes list, URL↔view
      state.ts                the changes and tmux windows, owned by the app
      events.ts api.ts cache.ts   the SSE client, the fetch helpers, the in-memory cache
      Sidebar.tsx             the navigation column: changes, pages, terminals
      icons.tsx icons/        the status glyphs, and the generated app icons
      styles.css manifest.webmanifest index.html
      ActionsMenu.tsx         the change page's action menu
      ChangeCard.tsx          the home list's card
      stateClass.ts Progress.tsx   the shared state-class helper and progress primitive
      moment.ts prefs.ts poll.ts notify.tsx LifecycleFailures.tsx
      routes.ts               the icons and the /* fallback

    pi/agent-state.ts           pi extension: publishes working/waiting to tmux
    scripts/extension.ts        installs/removes that extension
    scripts/app.ts              installs the app: macOS .app, or Linux entry + launcher
    scripts/app/mac.ts          the macOS install: builds ~/Applications/IWE.app with packager
    scripts/app/linux.ts        the Linux install: desktop entry, icons, iwe-app launcher
    scripts/app/electron/       the window: main.ts and preload.ts, built into main.cjs by build.ts
    scripts/app/run.ts drive.ts app:run (from the checkout) and app:drive (Playwright)
    test/                       the suite; test/terminal.test.ts drives a real pty and tmux
