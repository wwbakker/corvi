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
  "extensionSettings": {
    "jira": {
      "server": "https://example.atlassian.net",
      "email": "you@example.com",
      "project": "PROJ",
      "tokenEnv": "JIRA_API_TOKEN"
    },
    "azure-devops": { "organization": "", "project": "" }
  },
  "worktreeCopy": [".idea", ".bsp", ".bloop", ".scala-build", ".metals", ".vscode"]
}
```

## Locations and worktrees

- `changesRoot`: one directory per active change.
- `archiveRoot`: completed and cancelled change records/documents.
- `repositoriesDirectory`: the directory browser's starting location, defaulting to your home.
  It is not a confinement boundary: the browser can navigate to `/`.
- `worktreeCopy`: directory names to copy into new worktrees; see
  [what a new worktree inherits](changes.md#what-a-new-worktree-inherits).
- `ideationPrompt`: the text behind the **Send PLAN.md instructions** action. `{id}`, `{title}`,
  `{branch}`, `{plan}`, `{state}`, `{dir}`, and `{repos}` are substituted. An empty value uses the
  shipped `brief` action's text; a `brief.md` action file replaces the whole briefing.

Actions run from the terminal page's **Actions** menu (its files and the full set of fields are
on the Actions page).

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

## Saving settings

Saving applies settings without an application restart and clears affected cached answers. Empty
fields mean unset and show the applicable fallback as a placeholder. Fields controlled by an
environment variable are locked and name that variable. Each save keeps the file it replaces as
`config.json.bak` beside it — one generation, owner-only — so a save that went wrong is a copy
away from undone.

The server validates paths, workspace names/IDs, environment names, and worktree-copy names.
Relative location paths and entries such as `../.ssh` in `worktreeCopy` are refused. Saving
preserves unrecognized file keys rather than discarding content from another version.

Other settings include notification sound and the right-click context menu. The terminal's tmux
menu is independent of the browser/desktop context-menu setting.

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

A workspace is a configured context such as a client or personal projects:

```json
{
  "workspaces": [
    {
      "id": "client",
      "name": "Acme",
      "repositoriesDirectory": "~/Repos/acme",
      "env": {
        "GH_CONFIG_DIR": "~/.config/gh-client",
        "AZURE_CONFIG_DIR": "~/.azure-client"
      },
      "extensionSettings": {
        "jira": {
          "server": "https://acme.atlassian.net",
          "email": "you@acme.example",
          "project": "PROJ",
          "tokenEnv": "JIRA_TOKEN_ACME"
        },
        "azure-devops": {
          "organization": "https://dev.azure.com/org",
          "project": "Project"
        }
      }
    },
    { "id": "personal", "name": "Personal", "extensions": ["git", "github"] }
  ]
}
```

The workspace switcher filters changes and available features. **All work** is a filter, not a
workspace. With no configured workspace, Corvi supplies a default. Changes without a recorded
workspace belong to the first workspace. A direct link can still open a change outside the
currently selected filter. Each browser window keeps its own selection.

The current `extensions` list selects included features/integrations. An omitted list enables all;
an empty list enables none; a nonempty list is the complete selection. Jira and GitHub issues can
both be enabled for one change. The settings page provides switches, so manual editing is optional.

Workspace `env` values are applied to its CLI operations, with `~` expanded for paths. This allows
separate GitHub accounts or Azure logins in simultaneous workspaces. Requests about a change use
that change's workspace; other views use the selected workspace. Cached answers must remain
separate for different contexts and credentials.

## Environment overrides

Common variables include:

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
