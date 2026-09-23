# Integrations and included features

Available features depend on the scope's `extensions` list. Current configuration uses the
`extensions` and `extensionSettings` keys, at the global level and per workspace; see
[configuration](configuration.md). Included features
do not require installing external Corvi plugins.

## Jira over its own API

Configure the Jira server URL, email, project, and token in Corvi. No Jira CLI is needed. The
global settings define a default site; every workspace can override it field by field. A project
with one board selects it automatically; a project with multiple boards needs a configured board.

The change wizard lists sprint issues and backlog issues, with assignee/status/search filters.
You can select an existing issue, create one, or skip the step. Jira and GitHub issues can both
be associated with a change.

Starting work moves the issue to the configured start transition. Completing moves it to the done
transition. Corvi asks Jira which transitions are available; an unavailable transition reports
the available choices instead of silently succeeding. Cancelling does not move or close the issue.

Useful environment settings include:

- `JIRA_API_TOKEN`, or the workspace's configured `tokenEnv`.
- `CORVI_JIRA_ISSUE_TYPE` for a new issue, default `Story`.
- `CORVI_JIRA_ISSUE_TYPES` for listed types, default `Story,Bug`.
- `CORVI_JIRA_SPRINT_STATES`, default `active,future`.
- `CORVI_JIRA_START_TRANSITION` and `CORVI_JIRA_DONE_TRANSITION`.

Tokens can also be stored through settings; they are masked in the interface and the config file
is saved with owner-only permissions.

## GitHub

Corvi uses `gh` and its configured login. The dashboard shows each repository's pull request,
review status, checks, and unresolved threads waiting on you. Checks are grouped so large build
matrices can be collapsed.

Pull requests are found by the pushed branch, which can differ from the local name. An upstream
pointing at the remote default branch is not treated as a pull-request branch. A thread you last
answered is not counted as waiting on you; an unreadable author is counted conservatively.

When supported by the repository, stacked pull requests show their stack position. Creating a
pull request from another change's base can register the stack; without the preview feature,
the correct base is still used. See [completing a change](changes.md#completing-a-change) for merge
and acknowledgement behavior.

The GitHub issue picker appears after repository selection. It can select or create an issue,
use its title for the change, and close it on completion.

## Review changes

The **Review changes** tab groups local file changes by repository and shows the selected diff.
Clean repositories remain visible. Staged and unstaged versions of one path appear separately;
untracked files are diffed against an empty file. The view refreshes while you work.

**Commit…** opens one dialog for the change. The initial selection uses staged files, or all
files when none are staged. One message is applied separately to each selected repository.
Only the selected paths are committed; unrelated staged files stay staged. A failed repository
reports its error without preventing the others from completing.

**Push** shows the number of unpushed commits and pushes repositories that have work to send,
setting the upstream on first push. A branch without an upstream counts commits since its base,
not zero. Unstaging and discarding are not currently provided by this view.

## Notes

The dashboard's **Notes** card saves shortly after typing stops, on blur, and when navigating
away. Current storage is `extensions/notes/notes.md` under the change directory, so notes travel
with the archive. A root-level `notes.md` remains a fallback for existing data; new saves use the
namespaced file. The plan and notes occupy the document column, separate from status cards.

## Azure DevOps

The change dashboard shows pipeline runs per repository. A pipeline's status follows its newest
run; older failures remain visible without keeping the whole pipeline red. Successful runs can
show an artifact version from their logs. Running builds show elapsed time against historical
duration. A repository unknown to the configured pipelines does not produce a placeholder row.

The **Azure DevOps** page is independent of a change: rows are services, columns are environments.
It shows deployed versions and the latest deployment attempt. A failed latest attempt is visible
alongside the version that remains deployed.

Configure organization/project globally or per workspace. Deployment conventions use:

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

**Deploy…** reads recent versions when opened, with build, branch, completion time, and existing
environment placements. Parameter names can be learned from prior runs. When environments differ,
a promotion action can prefill the next deployment.

A later environment can receive only a version successfully deployed to the preceding environment.
The server enforces this, not only the dialog. Deployment failures remain visible; Corvi does not
maintain a second authoritative deployment database.
