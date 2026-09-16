# Integrations

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
answer — its defaults and the `CORVI_AZURE_*` environment variables included.

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

