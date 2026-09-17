# The wizard's draft lives in the page

> **Kind:** decision · **Status:** accepted

## Context

`App` owns the view, and `view.name === "new"` renders the wizard; every navigation replaced the
view, so the wizard unmounted and its form went with it. Filling in half an idea and then looking at
a terminal or the settings page lost everything typed, and `/new` — the only way back — started
empty.

Ideas themselves have a home (`Ideation`), but work that has not been submitted is not a change
yet: creation needs a workspace and a title, and writing an empty record for every press of **New**
would fill the changes root with abandoned entries.

## Decision

**A draft is a client-side value, one at a time, in the page's memory.** The form the wizard would
post — the step, id, branch, title, description, repositories, ticket, each extension's payload,
the edited-by-hand flags, and the workspace picked in the form — becomes a `Draft`
(`src/wizard/draft.ts`) owned by `App`. The Wizard is controlled by it. A draft is not a `Change`:
no route, no id, no disk, and `change.json` learns nothing.

**One draft, and it belongs to no context until it is created.** **New** opens the draft that is
there and creates one only when there is none. The workspace switcher decides where it lands,
exactly as it decides while the wizard is open; the form's own workspace choice is the fallback
under "All work". Parking several ideas is what `Ideation` is for, and creating one is a click
away.

**The column is the way back.** **New** sits beside the Ideas heading, and the draft is a row under
it — the typed title, or *New idea* — which reopens the wizard where it was left. It is highlighted
while the wizard is open, in place of the Changes entry.

**Exits are explicit; nothing else clears the draft.** A successful create clears it; a refused
create keeps the form. The wizard's button is **Discard** (the old Cancel): it throws the draft
away and goes home.

**Lifetime: the page.** No cookie and no `sessionStorage`: a reload or a restart forgets the draft.
`localStorage` could not do the job anyway — the app is served from a fresh port every launch and
an origin includes the port — and a persisted draft would resurrect a form the user did not ask
for. `cache.ts` already set the precedent: client state lives for the tab, and durable state
belongs to the server.

**The steps can read their own slot back.** `StepContext` gains `payload(extension)`, the read side
of `setPayload`; the Jira and GitHub-issues steps use it to restore the issue they picked, so a
reopened draft does not show a filled-in form beside a board with nothing selected.

## Consequences

- Nothing on the server changes: the routes, `change.json` and the lifecycle are untouched.
- A reload loses the draft — the accepted cost of "close the application and lose it".
- The draft row shows in every context, including one its own fields no longer name.
- A context with a different set of wizard steps may land a restored step index on a neighbouring
  step — the same thing switching the switcher does while the wizard is open.
- The steps' own browsing state (filters, scroll, dialogs) is not preserved; only the data the
  change is made of, plus the selection each step reads from its own payload.
