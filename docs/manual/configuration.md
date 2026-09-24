# Configuration

Corvi reads `~/.config/corvi/config.json`; `CORVI_CONFIG` overrides its location. The settings page
at `/settings` edits the same file. This page describes current configuration names, including
`extensions` and `extensionSettings`; it does not define an extension development interface.

```json
{
  "changesRoot": "~/corvi/changes",
  "archiveRoot": "~/corvi/changes-archive",
  "repositoriesDirectory": "~/Repos",
  "ideationPrompt": "",
  "extensions": ["git", "github", "jira", "azure-devops"],
  "extensionSettings": {
    "jira": {
      "server": "https://example.atlassian.net",
      "email": "you@example.com",
      "project": "PROJ",
      "tokenEnv": "JIRA_API_TOKEN"
    },
    "azure-devops": { "organization": "", "project": "" }
  },
  "worktreeCopy": [".idea", ".bsp", ".bloop", ".scala-build", ".metals", ".vscode"],
  "env": { "GH_CONFIG_DIR": "~/.config/gh" },
  "workspaces": [
    {
      "id": "acme",
      "name": "Acme",
      "settings": {
        "repositoriesDirectory": "~/Repos/acme",
        "extensionSettings": {
          "jira": { "server": "https://acme.atlassian.net", "tokenEnv": "JIRA_TOKEN_ACME" }
        },
        "env": { "GH_CONFIG_DIR": "~/.config/gh-client", "AZURE_CONFIG_DIR": "~/.azure-client" }
      }
    }
  ]
}
```

## Settings and scopes

Every setting exists at two scopes: at the top level of the file (the global level) and inside a
workspace's `settings`, where it overrides the global one key by key. The settings are:

- `changesRoot`: one directory per active change.
- `archiveRoot`: completed and cancelled change records/documents.
- `repositoriesDirectory`: the directory browser's starting location, defaulting to your home.
  It is not a confinement boundary: the browser can navigate to `/`.
- `worktreeCopy`: directory names to copy into new worktrees; see
  [what a new worktree inherits](changes.md#what-a-new-worktree-inherits).
- `ideationPrompt`: the text behind the built-in **Send PLAN.md instructions** action. `{id}`,
  `{title}`, `{branch}`, `{plan}`, `{state}`, `{dir}`, and `{repos}` are substituted. An empty
  value uses the shipped `brief` action's text; a `brief.md` action file replaces the whole
  briefing.
- `planTemplate`: the starting text of a new idea's `PLAN.md`, seeded into the wizard's plan
  editor. Literal Markdown, nothing substituted — the scaffold you edit away. An empty value
  leaves new plans empty.
- `notificationSound`: whether a notification plays the system sound. Absent means yes.
- `contextMenu`: whether right-clicking shows the browser's own menu. Absent means yes. The
  terminal's tmux menu is independent of this setting.
- `extensions`: which of the included integrations exist in this scope. Absent means all of
  them; an empty list means none. See [integrations](integrations.md).
- `extensionSettings`: the settings the extensions declare, under their own name.
- `env`: environment variables added to every `gh`, `az` and Jira call made in this scope.

One chain decides what applies to a piece of work:

1. an **environment variable** that names the setting wins at every scope (see below);
2. the **workspace's** value;
3. the **global** value;
4. the built-in **default**.

An empty or absent value means "not set" and hands the question to the next level; a set value
replaces the inherited one whole (a list is replaced, not merged). The record-shaped settings —
`extensionSettings` and `env` — resolve entry by entry: a workspace entry beats the global entry
for its key and leaves the others inherited. The exception is a secret setting (a Jira token,
say): its environment variable is a fallback rather than an override, so a stored token wins.

## Actions

Actions are files, one per action: YAML frontmatter for the delivery (`label`, `kind`,
`target`, `start`, `submit`, `phases`, `notify`, `keepOpen`) and the body for the prompt text or
command. The terminal page's **Actions** menu runs them; the **Actions** page (in the sidebar)
lists them by scope and edits the ones Corvi may write:

| Scope | Where | On the Actions page |
| --- | --- | --- |
| Built-in | shipped with Corvi | read-only — saving copies it to Global |
| Global | `~/.config/corvi/actions/` | created, edited, deleted |
| Workspace | `~/.config/corvi/workspaces/<id>/actions/` | created, edited, deleted |
| Repository | `<checkout>/.corvi/actions/` | not managed — create with your IDE or by the agent |

More specific wins on a collision (repository > workspace > global > built-in), and a `brief.md`
anywhere replaces the built-in briefing whole. A file that does not parse is listed with its
reasons rather than hidden: the page is where it gets fixed.

## Locations and worktrees

`changesRoot` and `archiveRoot` may be set per workspace: a change is created in its workspace's
roots, and completing it moves the record to that workspace's archive root. A change id is
unique across every root; lookup and listing search all of them, so a change made before a root
was overridden stays where it is and keeps working.

## Saving settings

Saving applies settings without an application restart and clears affected cached answers. Empty
fields mean unset and show the applicable value as a placeholder — inside a workspace, the
global value it would inherit. Fields controlled by an environment variable are locked and name
that variable. A workspace's own decision offers **use Global's**, which drops it and inherits
again. Each save keeps the file it replaces as `config.json.bak` beside it — one generation,
owner-only — so a save that went wrong is a copy away from undone.

Leaving the settings page with unsaved edits asks first — **Save and leave**, **Discard and
leave**, or **Stay**. Browser Back is held by the same question as clicking away. Reloading the
page is not: the draft lives only in the page.

The server validates paths, workspace names/IDs, environment names, and worktree-copy names at
both scopes. Relative location paths and entries such as `../.ssh` in `worktreeCopy` are refused.
Saving preserves unrecognized file keys rather than discarding content from another version.

## Credentials

GitHub and Azure DevOps use your CLI credentials (`gh auth login`, `az login`). Jira uses its
configured email and API token over HTTP basic authentication.

A Jira `token` in settings takes precedence over the variable named by `tokenEnv` (default
`JIRA_API_TOKEN`). The client receives a mask, not the stored token. Leaving the mask unchanged
preserves it; clearing the field returns to the environment-variable fallback. Config saves use
owner-only permissions (`0600`). Never share this file or an unredacted log as a bug report.

The root `extensionSettings.jira` is the default site. Workspace settings override it field by
field: `server`, `email`, `project`, `board`, `token`, and `tokenEnv`. A workspace with its own
`tokenEnv` uses that variable instead of inheriting the default site's stored token. The board is
automatically selected for a project with one board; otherwise Corvi asks you to choose.

Azure DevOps settings likewise support a workspace-specific organization/project. Empty values
can fall back to `az devops configure`. Some existing flat settings remain readable as fallbacks;
prefer the settings page and the structured keys above for new configuration.

## Workspaces

A workspace is a configured context such as a client or personal projects: an identity (`id`,
`name`) and a `settings` scope over the same settings the global level holds. The settings page
shows the two scopes as `Global` and one tab per workspace.

Older files that put `repositoriesDirectory`, `extensions`, `extensionSettings` or `env` directly
on a workspace entry keep working: they are read as that workspace's `settings` and folded there
on the next save.

The workspace switcher filters changes and available features. **All work** is a filter, not a
workspace. With no configured workspace, Corvi supplies a default. Changes without a recorded
workspace belong to the first workspace. A direct link can still open a change outside the
currently selected filter. Each browser window keeps its own selection.

The `extensions` list selects included features/integrations; the workspace's list overrides the
global one. An omitted list enables all; an empty list enables none; a nonempty list is the
complete selection. Jira and GitHub issues can both be enabled for one change. The settings page
provides switches, so manual editing is optional.

`env` values are applied to the scope's CLI operations, with `~` expanded for paths. This allows
separate GitHub accounts or Azure logins in simultaneous workspaces. Requests about a change use
that change's workspace; other views use the selected workspace. Cached answers must remain
separate for different contexts and credentials.

## Environment overrides

An override wins at every scope — the settings page shows the field locked and names the
variable. Common variables include:

| Variable | Purpose |
| --- | --- |
| `CORVI_CONFIG` | Config file path |
| `CORVI_ROOT`, `CORVI_ARCHIVE_ROOT` | Change and archive locations |
| `CORVI_REPOSITORIES_DIRECTORY` | Repository browser start |
| `CORVI_PORT` | Development/server port; the desktop chooses its own |
| `CORVI_WORKTREE_COPY` | Worktree-copy names; empty disables copying |
| `CORVI_CACHE` | Cache file path |
| `CORVI_PARALLEL` | Maximum concurrent CLI operations, default 8 |
| `CORVI_CLI_TIMEOUT` | CLI timeout in seconds, default 120; 0 disables |
| `CORVI_TRACE` | CLI timing diagnostics |
| `CORVI_JIRA_ASSIGNEE` | Jira assignee override |
| `CORVI_JIRA_START_TRANSITION`, `CORVI_JIRA_DONE_TRANSITION` | Jira transition names |
| `CORVI_AZURE_ORG`, `CORVI_AZURE_PROJECT`, `CORVI_AZURE_RUNS` | Azure organization/project and displayed run count |

See [integrations](integrations.md) for feature-specific settings.

## Local access

The server listens on localhost and acts with your filesystem and CLI credentials. Requests
identified as coming from another website are refused; requests such as local `curl` calls with
no browser-origin headers are allowed. This is not a multi-user server or a sandbox. Do not expose
it to a network without a separate authentication and authorization design.
