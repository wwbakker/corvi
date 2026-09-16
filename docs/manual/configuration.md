# Configuration

`~/.config/corvi/config.json` (override the location with `CORVI_CONFIG`):

```json
{
  "changesRoot": "~/corvi/changes",
  "archiveRoot": "~/corvi/changes-archive",
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
keys each extension declares ([`../guides/extensions.md`](../guides/extensions.md)). Empty values fall back to the tools' own
configuration: the account the Jira token belongs to (`/myself`) for the assignee, and
`az devops configure` for the Azure DevOps organisation and project. The flat fields
(`jiraAssignee`, and the retired `azureOrganization`/`azureDeploy` fields the azure-devops
extension reads from the file, …) are still read when the bag does not
answer, and the `CORVI_*` environment variables beat them — which is why the settings page locks
a field while its variable is set.

`changesRoot` holds one directory per change, and `archiveRoot` is where completed changes are
moved so it holds the work in flight; `reposRoot` bounds the repository browser and
`reposStart` is the directory it opens on, which `↑ Up` still walks out of, up to `reposRoot`.
`ideationPrompt` is the briefing pasted into an idea's terminal by **Brief the agent**
(`{id}`, `{title}`, `{plan}` and `{state}` are filled in from the change); an empty value uses the
built-in one. Environment variables still win: `CORVI_ROOT`, `CORVI_ARCHIVE_ROOT`,
`CORVI_REPOS_ROOT`, `CORVI_REPOS_START`, `CORVI_PORT`, `CORVI_JIRA_ASSIGNEE`,
`CORVI_JIRA_START_TRANSITION`, `CORVI_JIRA_DONE_TRANSITION`, `CORVI_AZURE_ORG`, `CORVI_AZURE_PROJECT`, `CORVI_AZURE_RUNS`,
`CORVI_CACHE` (where the cache is stored), `CORVI_PARALLEL` (how many CLIs may run at once),
`CORVI_CLI_TIMEOUT` (seconds a CLI may run before it is killed; 120 by default, 0 disables) and
`CORVI_WORKTREE_COPY` (see [what a new worktree inherits](changes.md#what-a-new-worktree-inherits); empty disables it).

## The settings page

Everything above is editable at `/settings`, last in the navigation column — the file stays the
source of truth and stays hand-editable, the page just writes it. Its tabs are the locations, the
worktrees, the extensions, the notification sound, the ideation prompt, the workspaces, and the
window — whose one setting so far is the right-click menu: the browser's own, which the app's window
draws for itself since Electron has none ([`../decisions/host-context-menu.md`](../decisions/host-context-menu.md)). **Saving takes effect at once**:
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
[../guides/extensions.md](../guides/extensions.md) — the jira and github-issues extensions each
contribute a wizard step and a card, and both can be on at once: two tickets on one change is a
thing, not a conflict. A workspace still carrying a retired name is migrated on load — `ci` becomes `github` +
`azure-devops`, `deployments` becomes `azure-devops`, the `deployments` bags move to
`azure-devops`, and a legacy per-workspace `azure` object (`false`, or
`{ organization, project }`) folds into the same bag (`false` additionally materializing an
explicit list without `azure-devops`). The retired flat `azureOrganization`/`azureProject`/
`azureDeploy` fields stay readable through the extension's own fallback until that is removed.
The migration is automatic, for hand-edits and settings-page writes alike.

Extensions do not have to live in this repository: `"extensionPaths"` in the config (or the
`CORVI_EXTENSION_PATHS` environment variable) names `.ts` modules or directories of them, loaded
at startup beside the built-ins through the same contract, with `~/.config/corvi/extensions/`
searched implicitly when it exists. A discovered extension's wizard step or page gets its
interface from a `client.tsx` beside the module, which the server builds and serves to the
page — see "Out-of-tree extensions" in [../guides/extensions.md](../guides/extensions.md).

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

