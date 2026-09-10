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

`git`, `wt`, `gh` and `az` for the integrations; `tmux` and `ttyd` for the Terminals tab. Jira is
talked to over its own REST API, but `jira-cli` is still what configures it — see below.

The same list applies on Linux (on Arch: `sudo pacman -S git worktrunk gh github-cli tmux ttyd`).
`wt` is [Worktrunk](https://github.com/max-sixty/worktrunk) — a cross-platform Rust CLI with an
official Arch package, and every invocation IWE makes was verified to behave identically on Linux
(`brew install worktrunk` on macOS; details and non-Arch installs in `docs/decisions/wt-on-linux.md`). For
the app's own window, Linux additionally wants `webkit2gtk-4.1` and `python-gobject`
(`sudo pacman -S --needed webkit2gtk-4.1 python-gobject` — standard on desktop installs), which
the macOS app gets from the system it is already in.

## Run

```bash
bun install
bun run dev          # http://127.0.0.1:4000
```

`dev` is `bun --watch`, which restarts the process, rather than `bun --hot`, which re-evaluates
modules inside the running one. The difference matters here: `Bun.serve` takes its routes once,
at startup, so under `--hot` a **newly added route never appears** — the request falls through to
the app's own HTML and arrives as a perfectly good `200 text/html`. The page then tries to parse
that as JSON and reports whatever the browser calls a parse error (Safari: "The string did not
match the expected pattern"), which is a sentence about nothing. Restarting is cheap: the cache
is on disk and the terminals belong to tmux, so both survive it.

The browser now says so plainly instead — anything answering an `/api` call with a non-JSON body
is reported as "the server has no /settings — it is probably running older code, restart it".

## Configuration

`~/.config/iwe/config.json` (override the location with `IWE_CONFIG`):

```json
{
  "changesRoot": "~/changes",
  "reposRoot": "~/Repos",
  "reposStart": "~/Repos/acme",
  "extensionSettings": {
    "jira": { "assignee": "", "startTransition": "In Progress", "doneTransition": "Done" },
    "deployments": { "organization": "", "project": "" }
  },
  "worktreeCopy": [".idea", ".bsp", ".bloop", ".scala-build", ".metals", ".vscode"]
}
```

The Jira and deployment settings are the extensions' own — `extensionSettings[name][key]`, the
keys each extension declares (docs/guides/extensions.md). Empty values fall back to the tools' own
configuration: the account the Jira token belongs to (`/myself`) for the assignee, and
`az devops configure` for the Azure DevOps organisation and project. The flat legacy fields
these replaced (`jiraAssignee`, `azureOrganization`, …) are still read when the bag does not
answer, and the `IWE_*` environment variables beat them — which is why the settings page locks
a field while its variable is set.

`changesRoot` holds one directory per change; `reposRoot` bounds the repository browser and
`reposStart` is the directory it opens on, which `↑ Up` still walks out of, up to `reposRoot`.
Environment variables still win: `IWE_ROOT`, `IWE_REPOS_ROOT`, `IWE_REPOS_START`, `IWE_PORT`, `IWE_JIRA_ASSIGNEE`,
`IWE_JIRA_START_TRANSITION`, `IWE_JIRA_DONE_TRANSITION`, `IWE_AZURE_ORG`, `IWE_AZURE_PROJECT`, `IWE_AZURE_RUNS`,
`IWE_CACHE` (where the cache is stored), `IWE_PARALLEL` (how many CLIs may run at once),
`IWE_CLI_TIMEOUT` (seconds a CLI may run before it is killed; 120 by default, 0 disables) and
`IWE_WORKTREE_COPY` (see below; empty disables it).

### The settings page

Everything above is editable at `/settings`, last in the navigation column — the file stays the
source of truth and stays hand-editable, the page just writes it. **Saving takes effect at once**:
the server refills the config object every module already imported rather than replacing it, so
there is no restart and no "changes will apply next time".

Two conventions run through the page:

- **An empty field is "not set"**, and shows what applies anyway as its placeholder. So the
  difference between a default and a decision stays visible, and clearing a field removes the key
  from the file rather than writing an empty string into it.
- **A setting an environment variable is overriding is locked**, with the variable named next to
  it. The variable wins, so an editable box would be a lie.

It writes by merging over what the file holds, so a key IWE does not know about — put there by
hand, for a newer version — survives being saved by an older one. Validation lives on the server
because the file can also be edited by hand: rules in the browser only would be rules that half
the ways in ignore. It refuses a relative path, a duplicate or non-word workspace id, a nameless
workspace, an environment name that is not one, and a `worktreeCopy` entry that is a path rather
than a name — `../.ssh` is not something a settings page should be able to ask for.

Saving also clears the cache. Everything the CLIs answered, they answered for the old settings:
another organisation, another Jira site, another set of environments.

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
nothing is configured twice. The CLI itself is no longer called: four values are read out of the
file it wrote, and the rest is HTTP.

## Creating a change

"New change" opens a wizard whose steps are its extensions', in phases — the issue steps first
(they prefill the change), then the change details, then the repositories, then steps that want
the repositories. Which steps a context has is resolved per workspace; an extension that is not
enabled there has no step, not an empty one.

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
3. **Change** — id and branch, prefilled from the picked issue, both editable.
4. **Repositories** — at least one is required, from a directory browser rooted at `reposRoot`. Clicking a name browses into
   it, the button beside it adds it to the selection: a directory that is both a repository and
   a parent of repositories (`acme/services`) can be either. Selected repositories are listed on
   the right and removed with the cross. A worktree is created per selected repository.

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

## The app

```bash
bun run app:install      # macOS: ~/Applications/Integrated Work Environment.app
bun run app:uninstall    # Linux: desktop entry, icons and the iwe-app launcher
```

A real application: an icon the app grid knows, a window whose title bar is the same colour as the
page, and the server inside it. Clicking it **starts the app's own server — on a fresh port,
picked at launch** — shows "Starting IWE…" on the page's own background while it waits, then loads
the app.

**The app always runs the production build, on a fresh port.** `bun run dev` keeps 4000. They used
to share a port, and the app attached to whatever was listening: a dev server left running from
last week silently became "the app", with last week's code and no way to tell from the window.
That is exactly how a missing `/api/settings` came to be reported as "The string did not match the
expected pattern". A fixed port of its own fixed that — until a *stale* server was left listening
on it, which the app then attached to with the same confidence. So the window now picks a free
port at each launch and starts its own server on it: there is nothing to attach to by mistake,
and nothing to collide with.

So the two are now separate things rather than two ways to start the same thing:

| | `bun run dev` | the app |
| --- | --- | --- |
| for | editing IWE | using IWE |
| port | 4000 | fresh each launch |
| build | rebuilt as you edit | built once, `NODE_ENV=production` |
| on a code change | restarts itself (`--watch`) | picks it up when you next launch it |
| output | your terminal | macOS: `~/Library/Logs/iwe.log` · Linux: `~/.local/state/iwe/log` |

On macOS it is AppKit and WebKit, in about two hundred lines of Swift (`scripts/app/IWE.swift`),
compiled by `swiftc` at install time. Both frameworks are in the system, so this costs a compile
and nothing at runtime: no Electron, no Rust, no second browser. Quitting the app stops the
server it started; a server you started yourself, in a terminal, is left alone. The window is
still only a view onto the same HTTP server any browser can open, which is the point — the app is
a convenience, not the product.

What the native window buys over a Chrome `--app` window:

- **A dark title bar.** A plain `--app` window ignores the manifest's `theme_color`; this one is
  `titlebarAppearsTransparent` over the page's own `#14161a`.
- **A Dock icon that means something**: it is there while IWE is running, and Quit stops it.
- **cmd-t is ours.** Chrome keeps it for new tabs in a normal window; here it always reaches the
  terminal.
- **Links leave.** Jira, GitHub and Azure DevOps open in your browser rather than replacing the
  page.
- **The page's questions get asked.** A WKWebView draws no dialogs of its own and does not
  complain either: `confirm()` returns `false` and `alert()` does nothing. Every confirmation in
  IWE — cancelling a change, a removal that would lose commits, deleting a leftover — therefore
  did nothing at all in the app, silently, while working in a browser. The window implements
  `WKUIDelegate` and shows them as sheets.

Two details that took a bug each:

- **It runs an interactive login shell** (`zsh -ilc`). A bundle launched from the Dock inherits
  nothing, and `bun` and `JIRA_API_TOKEN` are exported from `~/.zshrc`, which a *non-interactive*
  login shell does not read. `zsh -lc` looked right and failed with `command not found: bun`.
- **The root lives in `Info.plist`**, not in the binary, so moving the repository is a reinstall
  of a plist rather than a rebuild. The port is nobody's to configure: the window picks a free
  one at launch.

`app:install` **quits a running app and puts it back on the new build**: `open` on a running
application only focuses it, so a rebuild would otherwise leave you looking at the previous one —
a confusing ten minutes the first time it happens. It quits with an Apple Event rather than a
signal, so the app stops the server it started instead of orphaning it, and it compiles to one
side first, so a failed build leaves the app you have alone.

Failures land in `~/Library/Logs/iwe.log`, and a server that never answers leaves the window
saying so rather than showing an empty page.

### On Linux

The same `app:install` puts three things in your home directory: a **desktop entry**
(`~/.local/share/applications/iwe.desktop`), **icons** rendered from `assets/icon.svg` into
`~/.local/share/icons/hicolor/<size>/apps/iwe.png` (skipped with a note if `rsvg-convert` is
missing — the app works without one), and a **launcher**, `~/.local/bin/iwe-app`, with the
repository written in: the same trade as `Info.plist`, so moving the repository is a reinstall,
not a rebuild. The port appears nowhere in it — the window picks a fresh one at launch.

The window is WebKitGTK driven from Python through the bindings already on the machine, in about
three hundred lines (`scripts/app/linux-window/iwe-window.py`) — no Electron, no Rust, no second
browser, nothing compiled. The page's own `#14161a` behind it from the first frame, the page's
title in the title bar, `confirm()` and friends drawn as real dialogs, links to Jira, GitHub and
Azure DevOps handed to your browser, and the microphone granted through the window — the gap that
made a voice extension fail silently inside the macOS view, closed by asking the permission
deliberately for our own origin. Without the WebKitGTK bindings the launcher falls back to your
installed Chromium's `--app` mode.

Lifecycle: clicking the icon (or running `iwe-app`) opens the window, which then manages the
server exactly the way the macOS app does: it starts one of its own — on a fresh port, picked at
launch, through your login shell so `bun` and `JIRA_API_TOKEN` come from your rc file — and
**closing the window stops the server it started**. Terminals are tmux's and survive that, which
is the same promise a restart of the server has always made. The window records the pid of the
server it started in `~/.local/state/iwe/iwe-app-<port>.pid`, so `iwe-app stop` can still stop a
server left behind by a window that died harder than it could clean up after; it checks each pid
is still an IWE server and refuses anything else. Logs land in `~/.local/state/iwe/log`. Without the
WebKitGTK bindings the launcher falls back to the browser's app mode, where the server is
started detached and outlives the tab — a browser window cannot clean up after anything.
`app:uninstall` removes the entry, launcher and icons and leaves the logs alone.

## Installing it as an app

The page ships a web manifest and icons, so it installs as a standalone app — on macOS through
the browser, on Linux the desktop entry `app:install` writes plays that part:

- **Safari** — open the app, File → *Add to Dock*.
- **Chrome** — ⋮ → Cast, Save and Share → *Install page as app*.

Installed, the layout uses the full window (`@media (display-mode: standalone)`); in a browser tab
it keeps a readable 1200px column.

`http://127.0.0.1:4000` counts as a secure context, so no TLS is needed. The icon source is
`assets/icon.svg` (and `assets/icon-maskable.svg` for the padded, croppable variant); edit those
and run `bun run icons` to regenerate `src/web/icons/*.png` with `rsvg-convert`
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
configured any gets one **Default workspace**, which is what IWE was before workspaces existed
and behaves the same.

A change records the workspace it was made in (`"workspace": "client"` in `change.json`) — one
line, no directory moves, and moving a change between contexts later is one field. A change made
before workspaces existed has none and belongs to the **first** workspace, which is where all the
work was when there was only one place for it.

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
      "azure": { "organization": "https://dev.azure.com/org", "project": "Project" } },

    { "id": "personal", "name": "Personal", "extensions": ["git", "ci"] }
  ]
}
```

The per-workspace `azure` object — organisation and project overrides — stays: the deployments
implementation reads it through the `Workspace` tag, as that extension's own business. Which
extensions a workspace has is the `extensions` list (below); the old vendor flags that stood in
for it are migrated on load.

A workspace can also name **which extensions it has** (`"extensions": ["git", "ci",
"github-issues"]`): the cards, wizard steps, pages, summary facts and hooks it gets at all.
Naming none means all of them, which is what IWE was before this existed; naming some is the
whole list. Extensions are described in [docs/guides/extensions.md](docs/guides/extensions.md) — the jira and
github-issues extensions are the first two, and both can be on at once: two tickets on one
change is a thing, not a conflict. The old vendor flags are retired: a workspace still carrying
`"jira": false` or `"azure": false` (with no `extensions` list) is migrated on load — the flag
becomes an explicit list naming everything but the extension it excluded (jira, deployments),
and the legacy `jira` object is folded into `extensionSettings.jira`. The migration is
automatic, for hand-edits and settings-page writes alike.

Extensions do not have to live in this repository: `"extensionPaths"` in the config (or the
`IWE_EXTENSION_PATHS` environment variable) names `.ts` modules or directories of them, loaded
at startup beside the built-ins through the same contract, with `~/.config/iwe/extensions/`
searched implicitly when it exists. A discovered extension's wizard step or page gets its
interface from a `client.tsx` beside the module, which the server builds and serves to the
page — see "Out-of-tree extensions" in [docs/guides/extensions.md](docs/guides/extensions.md).

**A second client is a second site.** `extensionSettings.jira.configFile` points at another
`jira init` — its own server, account and board — `extensionSettings.jira.tokenEnv` names the
variable holding that site's token, and `azure.organization`/`project` are passed to `az`
explicitly rather than relying on its single configured default. Two clients can be open at
once.

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

`env` is added to **every** CLI IWE runs for that workspace — `git`, `gh`, `az`, `tmux`, however
deep the call — so two GitHub accounts or two Azure tenants stop fighting over one login. `~` is
expanded, since these are paths and a shell would have done it.

It is ambient rather than a parameter (`AsyncLocalStorage`, `src/context.ts`): the alternative is
threading an environment through forty call sites that have no other reason to know about it —
`git status` does not care whose workspace it is in, it only has to run as the right one. A
request about a change enters that change's workspace; a request that is not about a change
enters the one the browser named; outside a request the environment is empty, which is exactly
what every call did before workspaces existed.

Which means **every cache key carries the context**: `az:<workspace>:runs:<ref>`,
`jira:<site>:keys:…`. Two organisations answering the same question differently is precisely the
bug this prevents, and it would have looked like "why is my personal change showing the client's
pipelines".

The browser sends the chosen workspace where the request is not about a change
(`/api/ext/deployments/services?workspace=…`, `/api/ext/jira/issues?workspace=…`); where it *is*
about a change, the change says which workspace it belongs to and nothing has to be passed.

## Navigation

One column, down the left, from the top of the window:

    Changes                          the overview
    ┃ PROJ-1240                  ▶     the changes still going; picking one opens its dashboard
    ┃ Wait for the security review…
        >_ example-web - (gradle)   its terminals, under the change they belong to
    ┃ PROJ-1234                  ▶
    ┃ Anonymise customer names…
        >_ PROJ-1234
        >_ example-web - (pi working)
        >_ new                       another terminal, where the current one is

    Dashboard | Review changes       tabs on the change itself

It replaced a breadcrumb, a row of tabs and the terminal's own window strip, which between them
said where you were three times and disagreed about how. Everything you can go to is here, one
level deep: **a terminal in another change is one click**, not four.

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

**Opening a change starts nothing.** ttyd is asked for when a terminal is opened, not when the
dashboard is: asking on arrival left a ttyd — and, once the page connected, a tmux session —
behind for every change you so much as looked at. A change needs no terminal at all some days.
The cost is that the first terminal of a change takes a moment to appear, which is the honest
price of not starting one behind your back.

The column is **resizable**: drag its edge, and the width is remembered in `localStorage`. The
whole edge is the handle, because that is what you aim at, and the drag is followed on the window
rather than on the handle, since the thing being dragged moves out from under the pointer.

The pages of a change appear only once a change is picked, and disappear again on the overview.
Each page keeps its own URL, so a deep link opens exactly what you linked to.

## Looking at the UI

```bash
bunx playwright install webkit chromium   # once
bun run shot                              # WebKit, into shots/
IWE_ENGINE=chromium bun run shot
```

Walks home → wizard → each step against `IWE_URL` (default `http://127.0.0.1:4000`) and reports
any console errors. Faster than describing a layout bug in prose.

**WebKit by default, because that is what the app is.** The macOS window is a WKWebView — Safari's
engine — and the Linux window is WebKitGTK, the same engine family (`docs/decisions/linux-native-window.md`),
while development happens in Chrome, and everything that has escaped to being reported
lived in that gap:

- A route the server did not have came back as the app's own HTML with a `200`, and WebKit words
  the failed parse as *"The string did not match the expected pattern"* — a sentence about
  nothing, in a browser that was not being tested.
- `window.confirm` is not implemented by a WKWebView unless the app implements `WKUIDelegate`, and
  an unimplemented `confirm()` returns `false`. Every destructive action sits behind one, so
  cancelling a change silently did nothing — in the app only.

`test/webkit.test.ts` opens every route in WebKit, saves the settings page, and fails on anything
the engine complains about. It skips itself when the engine has not been downloaded, since that is
a 100MB step and nothing else in the suite needs it. It earned its place immediately: it found the
dashboard firing a readiness check that answered `400` when there is no GitHub remote, which the
page swallowed — the menu item was disabled with nothing to say. That is now a reason like any
other ("cannot complete: …"), which is what the reasons list is for.

```bash
bun run app:permissions   # what this terminal may do to the app's own window
```

```bash
bun run app:sandbox 4090 --open              # a copy that cannot be mistaken for yours
bun run app:drive "PROJ-123" Actions "Cancel change" OK
```

**Never test against the installed app.** `app:sandbox` makes a copy with its own bundle
identifier, its own name and its own port, pointed at whatever scratch server you like. A copy
made with `cp -R` keeps the identifier `dev.iwe.app`, and `tell application id "dev.iwe.app" to
quit` then goes to whichever bundle the system resolves — which is how quitting a test copy quit
the real app instead, in the middle of somebody's work. Everything that addresses a bundle now
addresses a **path**, which is exactly one app, and the window title says which copy you are
looking at.

Clicks the app's own window by the names a screen reader reads out — the sheets it draws because
a WKWebView draws none, its menu bar, its Dock icon. Playwright drives the page far better and
cannot see any of that. Three things had to be true before it worked, and each of them looked
like something else:

- **The web area is invisible to assistive clients until the app opts in.** WKWebView keeps the
  page's accessibility tree to itself, so the window had one anonymous group where its buttons
  should be. `NSApp.setAccessibilityEnabled(true)` publishes it — which also means VoiceOver can
  read IWE, which it could not before.
- **A menu item that has just been clicked no longer exists**, so asking it what it was called
  throws `Invalid index` — reported as the click having failed, when it is the click having
  worked. Name it before clicking it.
- **JXA hands back lazy references** into a tree that is re-rendering underneath, so a walk fails
  halfway through for reasons unrelated to what it was looking for. Every access is guarded, and
  a sheet already on screen is reported rather than walked past: a modal sheet makes every step
  say "NOT FOUND" for a reason that has nothing to do with what was asked for.

The page can be driven by Playwright, but the app around it — title bar, Dock icon, confirm
sheets, menus — can only be checked by looking at the real thing, and macOS gates that per
application. Without any permission the window *list* is still readable, which is enough to prove
a sheet opened (that is how the `confirm()` fix was verified). Screen recording adds screenshots;
accessibility adds clicking and reading labels. The check reports which of the two your terminal
has and how to grant the rest.

## Jira over its own API

`src/integrations/jiraHttp.ts` is the whole transport: read the config `jira init` wrote, basic
auth with `JIRA_API_TOKEN`, and one `fetch`. `src/integrations/jira.ts` is the integration on top
of it — sprints from `/rest/agile/1.0/board/<id>/sprint`, issues from that board's sprints and
from `/rest/api/3/search/jql`, transitions from `/rest/api/3/issue/<key>/transitions`.

It replaced `jira-cli`, which cost a process per call and answered in CSV — a format its own
plain mode could not even produce unambiguously, since it pads columns with the delimiter. The
whole board went from **2.2s across four processes to 0.6s in one**, and the parser it needed is
gone.

Two things that only the API can do, and both matter:

- **Transitions are asked for, not guessed.** `jira issue move KEY Done` fails with "transition
  not found"; the API lists what is legal from where the issue is now, so a wrong status says
  `cannot move to "Done" from here — available: To Do, In Progress`. That failure, silent, is
  what once left a change merged with its ticket still open.
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

When the branch below has a pull request of its own, IWE also registers the two as a **GitHub
stack** (a public preview feature): the new pull request is appended to that stack, or a stack of
the two is created. Reviewers then see the order of the work, and merging the bottom one carries
the rest along. It is best effort — a repository without the preview feature, or a base branch
with no pull request, simply gets the correct base and nothing more.

Stacking is worth avoiding when you can simply wait for the change below to merge; two deep is
manageable, four is a research project every time the bottom one moves.

### What a new worktree inherits

A worktree is a checkout of the same repository, but to IntelliJ it is an unknown directory: no
`.idea` means the project is imported from scratch, and no `.bsp` means there is no build server
to import it with. So on creation IWE copies those directories over from the repository —
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

None of this is IWE's state and none of it is in git; it is ignored, per-machine, and written by
other programs. It is copied once, at creation, and never touched again — a worktree that already
has a `.idea` keeps it, since the IDE has owned it since. Build outputs (`target`, `node_modules`)
are deliberately *not* copied: recreating them is a build, and a stale copy is worse than none.
Failing to copy is never fatal — the worktree is what was asked for.

`reposStart` in the config sets the directory the browser opens on; `↑ Up` still walks back to
`reposRoot`.

## Terminals

Each change has a **Terminals** tab: one tmux session named `iwe-<change id>`, started in the
change directory, served into the page by [ttyd](https://github.com/tsl0922/ttyd)
(`brew install ttyd`; on Linux the distro package, e.g. `sudo pacman -S ttyd`).

A terminal outlives the server: ttyd is detached, its pid and port are written to
`terminal.json` in the change directory, and the next start adopts it if it is still answering.
Restarting IWE — which is constant while working on IWE itself — therefore costs you nothing, and
the page keeps working straight through it. Completing a change is what ends a terminal for good.

ttyd is started when a terminal is opened, and not before: a dashboard you glanced at should not
leave a process behind. The dashboard cards are unmounted while a terminal is in front —
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
itself, in the `@agent` **tmux pane option**, which the agents extension's presenter reads out
of the same `list-windows` call as everything else. The overview believes it over the process
waiting for you is not work in progress, though its process is very much running.

`pi/agent-state.ts` is that reporter for pi — `agent_start` sets `@agent working`,
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
**cmd-t** (`ctrl-alt-t` on Linux, where the meta key is unreliable) — opens another.

A new window starts **where the current one is**, not back in the change directory: a new tab is
almost always "the same place, another thing", and `#{pane_current_path}` is what tmux's own
`ctrl-b c` binding uses anyway. cmd-t works from inside the terminal too, where the keyboard
usually is: the injected key script cannot open a window itself, so it forwards the key to the
page around the frame. In a browser tab Chrome keeps cmd-t for itself; installed as an app it
reaches us — on Linux the chord is ctrl-alt-t for the same reason, and it works in a browser tab
too. The keyboard stays in the terminal throughout: the navigation column's entries refuse
the focus a mousedown would give them, and opening a terminal focuses it, so you can type straight
away. tmux stays the source of truth — the column calls `list-windows`, `new-window` and
`select-window`, so the keys keep working and a session attached from a terminal stays in step.

Windows and panes are yours to make with the usual tmux keys — the **tmux cheat sheet** button
beside the page title lists them — which is also the answer to "how do I get more than one terminal":
tmux does that, IWE does not duplicate it. Mouse mode is switched on for the session, so the wheel scrolls the
pane instead of walking through shell history; it is set with `-t`, so tmux sessions you started
yourself keep your own settings — a change needs no terminal at all
some days and three in one repository on others, so IWE opens none for you. The session is the
shows, and the shells survive an IWE restart because tmux owns them, not us. ttyd listens on
loopback only (`lo0` on macOS, `lo` on Linux).

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
OSC 52 support, so tmux cannot reach the system clipboard by itself. On Linux the browser owns a
plain drag already, and the terminal takes **Ctrl+Shift+C / Ctrl+Shift+V** (middle-click pastes
the primary selection); the cheat sheet button lists the keys for the platform you are on.

A terminal that comes up blank: ttyd logs to `/tmp/iwe-ttyd-<change id>.log`, and the session is
reachable from a normal terminal, which tells you quickly whether the problem is tmux or the
browser. After changing the manifest, reinstall the app — Chrome keeps the old one otherwise.

Completing a change kills its session and ttyd, since the change directory moves into the archive
underneath it.

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

## The order things are listed in

Active changes, in the navigation column and on the overview, are sorted by **state first and then
newest first**:

```
In Progress       ← what you can get on with
Awaiting Review   ← what is with somebody else
Blocked           ← what is stuck
```

That is `CHANGE_STATES` itself, so there is one order and it is used twice: the state select
offers them in it, and the lists sort by it. Within a state the newest change is on top, because
that is the one you are most likely to be looking for.

Finished changes — completed and cancelled — go to a table below, newest first, with a column
saying which of the two it was. A change that was abandoned is not one that landed, and that is
the first thing you want to know about a row down there.

`Settings` sits at the bottom of the navigation column rather than under the list: it is where you
go once in a while, and it should be in the same place whether you have two changes or nine.

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

**The name is editable**: click it in the change's header and type. A ticket's summary is written
for whoever files tickets, and it is not always what the work is to you. Renaming sets
`titleEdited`, and a change with that set is not asked about again — its ticket is left out of
the query entirely, so nothing overwrites your words later. Clearing the field hands the name
back to Jira.

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

## Deployments

A page of its own, beside `Changes` in the navigation column: one row per service, one column per
environment, and what each of them holds.

    SERVICE                ACCEPT                          PRODUCTION
    example-service        ● 20260827_072639_9a38834  4d ago  ● 20260827_072639_9a38834  4d ago
    example-app          ● 20260824-082948-bbba9816 8d ago  ● 20260811-085715-2a8503e7 20d ago

**Not part of a change, deliberately.** You deploy a service's build to an environment, and which
change produced that build is a separate question — often somebody else's. "What is on accept?"
is asked before a release and during an incident, when there is no change open to ask it from.
This is the first part of IWE that is not about a change, and it is the exception that earns it.

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

Configured under the deployments extension's own settings — `extensionSettings.deployments` on
the settings page, or by hand — because none of these names are ours:

```json
{
  "extensionSettings": {
    "deployments": {
      "pipeline": ["build-", "deploy-"],
      "versionParameter": "dockerTag",
      "environmentParameter": "environment",
      "environments": ["accept", "production"]
    }
  }
}
```

The flat `azureDeploy` field these replaced is still read when the bag does not answer — its
defaults and the `IWE_AZURE_*` environment variables included.

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
knows the branch is there). The change is archived as `Cancelled`, and stays readable: what was
abandoned is worth being able to look up.

### After it ends

A finished change — completed or cancelled — keeps its dashboard, without the buttons. Its
worktrees are gone and its directory is in the archive, so `Create worktree` and the rest offer to
half-revive something that is over; the rows stay, because what a change touched is worth reading
afterwards, and so does the `⋯` menu, because opening one of its repositories still makes sense.
The action route refuses too, with a 409: the page may have been open since before the change
ended, and the server is where the truth lives.

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

`/` lists changes, `/new` is the wizard, `/deployments` is the deployments page, `/settings` is
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

The navigation column used to ask for the terminal windows every 1.5 seconds and the overview for
the changes every 30, from every open page, against a browser limit of six connections per origin
— the limit that forces the dashboard's widgets to be unmounted rather than hidden while a
terminal is on screen. Now the server looks once, on one timer, for everybody.

**Events carry no data.** They say that something changed; the page then asks for it through the
same cached routes as before. That keeps this small — no second way to fetch anything, no state to
keep in sync — and means a missed event costs one refresh rather than a screen that disagrees with
the disk.

Three things it has to get right, all of which it got wrong first:

- **The watcher stops when the last page goes.** A process quietly reading the disk and asking
  tmux twice a second for a browser that was closed this morning is a bug you never see. Clients
  are forgotten on the request's abort signal — the stream's own `cancel` is not called when a tab
  closes, so without it nobody was ever removed.
- **What was last seen survives a disconnect.** Clearing it made the first look after every
  reconnect silent, which swallowed anything that changed while nobody was listening.
- **A quiet stream still has to say something.** Bun closes an idle connection after ten seconds,
  and an event stream is idle by definition. The browser reconnects, so it half-works: a drop and
  a reconnect six times a minute, for ever, with `request timed out` in the log each time. There
  is a heartbeat every five seconds, and `idleTimeout` is raised as well.

Routes that change something announce it themselves, so your own action lands at once rather than
within a tick. That is an optimisation, not the mechanism: the watcher would find it anyway, which
is why a `git` command in a terminal or a hand-edited `change.json` shows up too.

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
edit `bun --watch` cannot take — and without it every page waits for the CLIs all over again.
Entries older than six hours are not restored: a page painted from yesterday's builds is worse
than a page that waits.

Subprocesses are bounded at eight at once (`IWE_PARALLEL`), and a CLI that has not finished
within two minutes (`IWE_CLI_TIMEOUT`) is killed and reported as a failed command. A dashboard of six repositories asks
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
`src/extensions/index.ts` and, when it has a step or a page, to the client registry in
`src/web/extensions.tsx`; an out-of-tree one is added to `extensionPaths` in the config instead
and registers nowhere.

## Tests and your real changes

`bun run test` sets `IWE_ROOT` to a directory under `$TMPDIR`, so no test run can write into the
changes root you actually use. This is a safety net rather than the rule — test files set their
own root — and it exists because the net was missing the day it was needed: `setRepos` used to
refuse an empty repository list before writing anything, so `test/provision.test.ts` never touched
the disk and never said where it would. Allowing a change to be emptied made that same test write
a `PROJ-1` into the author's real `~/changes`.

## Testing the terminal

`test/terminal.test.ts` drives the real thing: it starts a server on a temporary root, opens the
Terminals tab in Chromium, types `pwd > out.txt` into the frame and reads the file back, then
checks `ctrl-b c` reaches tmux, mouse mode is on, and that asking twice reuses one ttyd. It skips
itself when `ttyd` or `tmux` is missing rather than failing.

## Layout

The layers, and the rule for where a feature's code lives, are in
[docs/guides/architecture.md](docs/guides/architecture.md). The documentation itself is indexed at
[docs/README.md](docs/README.md): `docs/guides/` is durable, `docs/decisions/` records why a
choice was made, and `docs/plans/` holds active work only.

The map, grouped by layer:

    src/server.ts             Bun.serve: /api/*, /api/ext/:name/* dispatch, SSE, ttyd ws-proxy
    src/effect/               errors (the taxonomy) · http→status · runRoute · Workspace tag
    src/schemas/              Effect Schemas for change.json and config.json
    src/context.ts            the workspace across the Promise seam (kept for the test suite)
    src/sh.ts                 the subprocess gate, timeout and trace
    src/cache.ts              stale-while-revalidate for everything the CLIs answer
    src/events.ts             the SSE hub and the watcher behind it

    src/changes.ts            change.json read/write, worktree paths, the archive
    src/complete.ts           completing a change: merge, close, archive
    src/cancel.ts             abandoning a change: worktrees back, nothing else touched
    src/commit.ts             one commit per repository, with one message
    src/local.ts              uncommitted work in a repository, and one file's diff
    src/summary.ts            the numbers on an overview card, as contributed facts
    src/titles.ts             what a change is called, from its ticket
    src/description.ts        the pull request description an action copies
    src/settings.ts           reading and writing the config file from the page
    src/config.ts             config file + env overrides
    src/repos.ts              directory browsing under reposRoot, remote branches
    src/leftovers.ts          directories in the changes root without a change
    src/branch.ts             branch-name derivation (shared with the browser)
    src/tooling.ts            IDE state carried into a new worktree, paths rewritten
    src/platform.ts           platform detection
    src/origin.ts             refusing requests another site made
    src/types.ts              the vocabulary the server and the page share

    src/terminal.ts           tmux sessions and the ttyd that serves them
    src/terminalProxy.ts      ttyd proxied through our origin, and the key-fixing script
    src/deployments.ts        what is deployed where, per service and environment
    src/deploySettings.ts     the deployments extension's server-wide settings, read back
    src/deployConventions.ts  how a build pipeline's name maps to its deploy twin

    src/integrations/         vendor CLI wrappers
      git.ts                  worktrees and checkouts (wt, plus plain git)
      github.ts               pull requests, review threads, merges
      azure.ts                Azure DevOps pipelines and runs
      checks.ts               GitHub Actions checks on a pull request
      stacks.ts               stacked pull requests

    src/extensions/           the extension host and the built-ins
      index.ts                the loader, the registry, the route dispatcher
      api.ts                  the whole contract an extension sees
      services.ts             the live layers behind Shell/Cache/Settings/Bus/Workspace
      presenters.ts           window presenters, a leaf (it breaks a module cycle)
      clientChunks.ts         builds out-of-tree client halves for the page
      agents/ git/ ci/ jira/ github-issues/ deployments/    the built-ins

    src/web/                  the React app, bundled by Bun's HTML import
      app.tsx                 shell, changes list, URL↔view
      state.ts                the changes and tmux windows, owned by the app
      events.ts api.ts cache.ts   the SSE client, the fetch helpers, the in-memory cache
      Wizard.tsx              per-component change wizard
      ChangeView.tsx          widget dashboard for one change
      ChangeCard.tsx          one active change on the overview
      LocalPane.tsx           the review-changes tab: files, and a diff
      CommitDialog.tsx        committing across the change
      RepoBrowser.tsx         repository picker: mode and base branch per repository
      SettingsPage.tsx        the config file, as a form
      Sidebar.tsx             the navigation column: changes, pages, terminals
      TerminalPane.tsx        the terminal itself, with CheatSheet.tsx
      NotesCard.tsx           notes.md for a change
      CompletionCard.tsx      how far completing a change got
      Leftovers.tsx           directories left in the changes root
      extensions.tsx          the hosts for an extension's step and page
      icons.tsx icons/        the status glyphs, and the generated app icons
      styles.css manifest.webmanifest index.html
      ActionsMenu.tsx changeState.tsx EditReposDialog.tsx   the rest of the furniture
      moment.ts newWindowKey.ts prefs.ts Progress.tsx

    pi/agent-state.ts           pi extension: publishes working/waiting to tmux
    scripts/extension.ts        installs/removes that extension
    scripts/app.ts              macOS: builds ~/Applications/IWE.app; Linux: installs the app
    scripts/app/linux.ts        the Linux install: desktop entry, icons, iwe-app launcher
    scripts/app/linux-window/   the Linux window: WebKitGTK via PyGObject
    scripts/app/IWE.swift       the macOS window: WebKit, and the server inside it
    test/                       the suite; test/terminal.test.ts drives a real ttyd and tmux
