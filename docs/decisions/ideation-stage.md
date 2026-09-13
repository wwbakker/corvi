# Ideation: an idea before a change

> **Kind:** decision · **Status:** accepted

## Context

A change began at `In Progress`: creating one cut a branch and worktree in every
selected repository and moved the Jira ticket. Work that was still being thought
through had nowhere to live — it either became a half-provisioned change or
stayed out of IWE entirely, where no agent and no plan could reach it.

## Decision

**One entity, one new state.** A change keeps its record, directory, DTO and
routes; `Ideation` joins `CHANGE_STATES` as its first entry. *Idea* is the label
for a change in that state, not a second entity — renaming the noun would touch
the on-disk format (`change.json`, `~/changes/`), the API and every install. The
overview and the navigation column group ideas into their own block rather than
ranking them among the attention states, so `CHANGE_STATES` stays the one order
the select and the sort both use.

**Creating and starting are different moments.** Creation produces `Ideation`:
it needs a workspace and a title, writes `change.json` and `PLAN.md`, and touches
neither a branch nor a ticket. Starting is a real action
(`POST /api/changes/:id/start`), not a value in the state select, because it does
more than set a word: it provisions each repository's checkout and moves the
ticket, and completing an idea is refused for the same reason — there are no
checkouts to merge and no ticket that started. `applyPatch` refuses `Ideation`
the same way it refuses the finished states.

**The core names the moment; vendors subscribe.** A new `change:started` event
carries it. The git extension provisions on `change:started` (and only links
repositories for browsing on `change:created`), and the Jira extension moves the
ticket there rather than on creation. So a start is one transition every
integration follows, and a workspace without Jira loses nothing. This is why
Jira follows the core's flow instead of the core knowing about tickets.

**Looking at code is not working on it.** An idea links its repositories into
the change directory without switching their branch or registering a worktree;
adding one later links it, and removing one takes the link back. No branch exists
until the work starts, so an idea that never starts leaves nothing behind in git.
The link lives at the same path the worktree later takes, so the terminal's
working directory — and therefore the pi session scoped to it — does not move
when the work starts.

**The rule is briefed, not enforced.** IWE cannot make a symlinked repository
read-only, and pi has no sandbox (`pi/docs/security.md`): it runs with the user's
permissions. Rather than pretend, IWE pastes a prompt into the change's terminal
that states the idea, the plan path, and the "only `PLAN.md` changes" rule. The
text is the `ideationPrompt` setting (with `{id}`, `{title}`, `{plan}`,
`{state}`), so the wording is yours; the session is created if the terminal is
not up, and the text is pasted without submitting, because IWE cannot tell a
running agent from a shell.

**The plan is a file.** `PLAN.md` at the change root, a core sidecar
(`CORE_SIDECARS`) so it archives with the change, read and written through
`readSidecar`/`writeSidecar`. The agent edits the file and the dashboard edits
the same file; it is not a field of `change.json`. The card stays on the
dashboard once the work starts — the plan is the change's document, not the
phase's — and becomes read-only, in the card and in the route, once the change is
finished.

## Consequences

- Existing changes and direct `createChange` callers keep `In Progress` as the
  default; only the wizard creates ideas.
- A start that fails half way leaves an `In Progress` change with a component
  reported missing, exactly as creation does — the record is written first.
- The idea's repository list is optional, so an `In Progress` change with no
  checkout is reachable; that was already possible through `setRepos`.
- The brief goes stale when the phase changes, because a pi session outlives it;
  the prompt names the state rather than assuming it, and Settings can re-send.
