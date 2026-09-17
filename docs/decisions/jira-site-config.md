# Corvi owns the Jira site

> **Kind:** decision · **Status:** accepted

## Context

The jira extension has always spoken to Jira's REST API directly — `/rest/api/3/search/jql`,
`/rest/agile/1.0/board/<id>/sprint`, `/rest/api/3/issue/<key>/transitions`, ADF descriptions — and
it never ran the `jira` binary. What it did do was read its **configuration** out of
`jira-cli`'s own config file: four scalars (`server`, `login`, `board.id`, `project.key`) pulled
out of a megabyte of custom-field YAML by a hand-written regex reader, with the token expected in
`JIRA_API_TOKEN` because that is the variable jira-cli documents.

That put a third-party CLI in the loop for setup, and nothing else. Three consequences, none of
them visible from the code:

- **Installing Corvi meant installing jira-cli**, or at least knowing its file format well enough
  to write one. Every error message that came out of the extension said "run `jira init`".
- **The site was read by regex** from a file another tool owns: four values at known depths,
  which is cheap until the shape changes.
- **A credential could only come from one place per process** — an environment variable — while
  the rest of the site was per workspace. A second client needed a second exported variable and a
  second `jira init`.

Meanwhile Atlassian moved on: scoped (granular) API tokens must go through
`https://api.atlassian.com/ex/jira/{cloudId}/…` and get a 401 against the site URL, service
accounts can only create those, and unscoped tokens are announced as being deprecated. A site
Corvi does not know about is a site it cannot resolve a `cloudId` for.

## Decision

**The site is Corvi's own configuration, and no vendor CLI is part of the Jira path** — not to
run, not to configure, and not to hold the token.

- **Two levels, field by field.** `extensionSettings.jira` at the config root is the default site;
  a workspace's own bag overrides it where it speaks and inherits where it is silent. The fields
  are `server`, `email`, `project`, `board`, `token` and `tokenEnv`, all declared by the extension
  and rendered by the settings page like any other setting.
- **The board comes from the project.** A board id is the least knowable thing in the set, so when
  `board` is unset the project's boards are asked for: one is used, several are listed in the
  error and `board` settles it. The lookup is cached like any other Jira read.
- **The token comes from the environment or from the settings, and the setting wins.** A
  credential typed against a site is more specific than a variable set for whatever process
  started the server — the same reason a workspace's bag beats the default site. `tokenEnv` names
  the variable (`JIRA_API_TOKEN` by default), and a workspace that names its own does not inherit
  the default site's stored token, or one client's credential would be sent to another with no way
  to say otherwise.
- **A clean break.** The jira-cli config file is not read, `JIRA_CONFIG_FILE` no longer means
  anything to Corvi, and the per-workspace `configFile` field is gone. Existing installs configure
  the site once, in Corvi.

**Why not the official Atlassian CLI (`acli`).** It covers most of the surface — work item
search, view, create, edit, assign and transition, board sprints, sprint work items, and its own
`auth login` with API tokens or OAuth — and Atlassian maintaining the auth is a genuine argument,
especially for the scoped-token move. It is still the wrong trade: it cannot list a work item's
available transitions (they are an `expand` on the issue, not a field, so `--fields '*all'`
returns `transitions: null`), which is the one thing that stops a wrong status from silently
leaving a merged change with its ticket open; it turns one request into one subprocess per call,
and the board view fans out over every sprint; each version is supported for six months, so its
`--json` shape would be a moving target; and it keeps its own credential store, which means
handing a third party the token rather than taking one from the environment or from Corvi's own
settings.

## Consequences

- The extension's error messages name the field to fill in — `no Jira server for this workspace —
  set Server in Settings` — instead of naming a command to run.
- **A site that is not the default needs a visit to the settings page.** The default covers every
  workspace at once, so this is usually one visit, but a workspace that carried only a
  `configFile` must now name its `server`, its `email` and its token source.
- `board` and `project` stop being inherited from another tool's file: an issue table needs a
  project, and an issue created without one says so.
- A site whose address is not a URL is a `BadRequestError` naming the setting. It used to be an
  unhandled defect, because `new URL` threw outside the request's error mapping — unreachable
  while jira-cli wrote the file, reachable now that a person types it.
- The config file may hold a token, so it is written for its owner alone and the token is masked
  in the page: see [`extension-secrets.md`](extension-secrets.md). The README no longer claims
  Corvi stores no secrets; it says which one it can store and on what terms.
- **Scoped tokens are the next step, and this is what makes it small.** `jiraHttp.ts` needs one
  memo (`server` → `cloudId` from `https://<site>.atlassian.net/_edge/tenant_info`) and one
  base-URL choice to speak to the gateway; the tests' URL assertions are the rest.
