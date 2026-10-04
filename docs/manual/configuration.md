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
  "remoteAccess": { "enabled": true, "port": 4110 },
  "devices": [
    {
      "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "name": "Laptop",
      "tokenHash": "…",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "lastSeenAt": "2026-01-02T09:00:00.000Z"
    }
  ],
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
    },
    {
      "id": "remote-acme",
      "name": "Acme (other machine)",
      "remote": {
        "url": "https://other-machine.tailnet.ts.net",
        "workspace": "acme",
        "token": "…"
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
  terminal's own menu follows this setting too.
- `extensions`: which of the included integrations exist in this scope. Absent means all of
  them; an empty list means none. See [integrations](integrations.md).
- `extensionSettings`: the settings the extensions declare, under their own name.
- `env`: environment variables added to every `gh`, `az` and Jira call made in this scope.

Top-level and machine-level — not settings, and with no workspace override — are also:

- `remoteAccess`: the external (remote-access) listener: `enabled` (off by default) and `port`
  (default `4110`). It is a second loopback listener an authenticated client on the tailnet can
  reach; see [local and remote access](#local-and-remote-access).
- `devices`: the devices paired to this machine, each with only a hash of its token. A device is
  this machine's trust, so it is not a workspace's; manage them under Settings → Devices.

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
| Built-in | shipped with Corvi | templates in the create flow — a copy lands in the scope you pick |
| Global | `~/.config/corvi/actions/` | created, edited, deleted |
| Workspace | `~/.config/corvi/workspaces/<id>/actions/` | created, edited, deleted |
| Repository | `<checkout>/.corvi/actions/` | in the Repositories block — created, edited, deleted |

Creating is one template picker: **Blank**, or a copy of a built-in — its text previewed, the
id defaulting to the template's own, so the copy shadows the shipped file while it exists.

More specific wins on a collision (repository > workspace > global > built-in), and a `brief.md`
anywhere replaces the built-in briefing whole. A file that does not parse is listed with its
reasons rather than hidden: the page is where it gets fixed.

What the page does, the CLI does too: `corvi action profile write <id>
--scope global|workspace|repository` and `… profile delete` write the same files (the scope is
explicit; a repository file names its checkout with `--repository <name>` and the change with
`--change`), and `corvi action profile list` shows each one as written.

Editing one opens the file in the Markdown editor the plan uses, with the fields' documentation
beside it — each field, what it is for, and the values it takes. The panel opens and closes from
its button and stays where it was left; the field your caret is in is lit.

Leaving the editor with unsaved edits asks first — **Save and leave**, **Discard and leave**, or
**Stay** — as the settings page does. **Cancel** is the deliberate discard: back to the list,
dropping the draft.

## Subagent profiles

A subagent profile is a template for a visible, persistent agent session inside a change: which
harness to start, the model and thinking effort, and the initial prompt. Profiles are files too,
with the same scopes and precedence as actions, and the **Subagents** page edits them the same
way:

| Scope | Where | On the Subagents page |
| --- | --- | --- |
| Built-in | shipped with Corvi | templates in the create flow — a copy lands in the scope you pick |
| Global | `~/.config/corvi/subagents/` | created, edited, deleted |
| Workspace | `~/.config/corvi/workspaces/<id>/subagents/` | created, edited, deleted |
| Repository | `<checkout>/.corvi/subagents/` | in the Repositories block — created, edited, deleted |

What the page does, the CLI does too: `corvi subagent profile write <id>
--scope global|workspace|repository` and `… profile delete` write the same files (the scope is
explicit; a repository file names its checkout with `--repository <name>` and the change with
`--change`), and `corvi subagent profile list` answers with the keys `corvi subagent create`
accepts.

The frontmatter names `label` and `harness` (`pi` or `opencode`); `model` and `effort` are passed
to the harness and are checked loosely, because a model catalog changes with the harness. `phases`
limits when the profile is offered. The body is the initial prompt; `create` sends it rendered,
with the same facts as an action (`{id}`, `{title}`, `{branch}`, `{plan}`, `{state}`, `{dir}`,
`{repos}`) plus `{prompt}`, which the delegating task text fills in — or, without it, the task is
appended as a final `## Task` section. An absent or empty task fills `{prompt}` with "Please await
your initial instructions." (a body-less profile sends that text alone). A file that does not parse
is listed with its reasons.

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

A remote workspace's device token is a credential too. It lives in `config.json`, owner-only.
Every **read** of it is masked — the settings view and `GET /api/workspaces` carry a mask, and the
page is never handed the stored value. It is handed over exactly once, when it is obtained: the
settings editor's **Pair** calls the pairing helper (`POST /api/workspaces/pair-remote`), which
redeems a code on the remote and returns the raw token for the editor to store, and the
gateway/CLI obtain one through `POST /api/devices/pairing-codes/redeem`. A mask (or an omitted
token) keeps the stored one only while `remote.url` and `remote.workspace` are unchanged; changing
the target drops it, and the workspace has to be paired again. Treat `config.json` as a secret
when a remote workspace is configured, exactly as with a Jira token.

A Jira `token` in settings takes precedence over the variable named by `tokenEnv` (default
`JIRA_API_TOKEN`). The client receives a mask, not the stored token. Leaving the mask unchanged
preserves it; clearing the field returns to the environment-variable fallback. Config saves use
owner-only permissions (`0600`). Never share this file or an unredacted log as a bug report.

The root `extensionSettings.jira` is the default site. Workspace settings override it field by
field: `server`, `email`, `project`, `board`, `token`, and `tokenEnv`. A workspace with its own
`tokenEnv` uses that variable instead of inheriting the default site's stored token. The board is
automatically selected for a project with one board; otherwise Corvi asks you to choose.

Azure DevOps settings likewise support a workspace-specific organization/project. Empty values
can fall back to `az devops configure`.

## Workspaces

A workspace is a configured context such as a client or personal projects: an identity (`id`,
`name`) and a `settings` scope over the same settings the global level holds. The settings page
shows the two scopes as `Global` and one tab per workspace.

A workspace is also **local or remote**. A remote workspace is a normal entry beside the local
ones, but it names a workspace on another server and carries no settings of its own:

```json
{
  "id": "remote-acme",
  "name": "Acme (other machine)",
  "remote": { "url": "https://other-machine.tailnet.ts.net", "workspace": "acme", "token": "…" }
}
```

The local `id` is the workspace's identity in this client; `remote.workspace` is the id of the
workspace on the **remote** server, and `remote.url` is that server's published base URL (see
[local and remote access](#local-and-remote-access)). `remote` and `settings` are mutually
exclusive: a remote workspace's settings live on the server that hosts it, so Corvi refuses a save
that carries both. Select it in the switcher like any other workspace — its changes are read
through the local server's gateway and shown beside the local ones, and **All work** shows both.
The settings page's editor adds, pairs, edits and removes one; see
[remote access](install.md#remote-access).

One caveat for a remote server with several workspaces: a change read from it records the id this
client knows it by, and some change-page calls — the extension issue pickers, the notes card, the
repository browser — send that as `?workspace=`. The remote resolves an id it does not know to its
first workspace, so those particular calls may read the wrong one; a remote server that hosts a
single workspace (the common case) is unaffected.

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

## Local and remote access

The server listens on localhost and acts with your filesystem and CLI credentials. Requests
identified as coming from another website are refused; requests such as local `curl` calls with
no browser-origin headers are allowed. This is not a multi-user server or a sandbox.

There are two loopback listeners, and the difference between them is trust:

- The **local listener** is the one you open on this machine. It stays tokenless — being on the
  loopback port *is* the authorization.
- The **external listener** is a second loopback port, off by default (`remoteAccess.enabled`,
  port `4110`), that `tailscale serve` publishes on the tailnet as
  `https://<machine>.<tailnet>.ts.net`. Every request to it must present a paired device token,
  as an `Authorization: Bearer` header (the gateway and CLI) or an `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie (the remote page). Two routes are the exception —
  `POST /api/devices/pairing-codes/redeem` and `POST /api/devices/pair` — because pairing happens
  before a token exists.

Trust is therefore a property of the listener, not of the peer address: through `tailscale serve`
the server sees every connection from `127.0.0.1`. A paired device acts as you — full access,
the same trust the local listener already has — so pair only devices you control, and revoke one
under Settings → Devices when it is lost. See [install](install.md#remote-access) for the setup.
