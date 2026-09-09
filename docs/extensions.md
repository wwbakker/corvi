# Extensions

An extension is a piece of TypeScript that adds something to IWE — a dashboard card, a step in
the "Create change" wizard, a hook that runs when a change is created, a route, a source of
titles for the overview. It is the shape pi's extensions have: a module whose default export is
a factory receiving an API object, contributing to registries instead of being wired in by hand.

Handlers are **Effects**, and that is the dependency-injection contract:

- **The host provides the capabilities** — the request's `Workspace` tag, a `Shell` for
  subprocesses with the workspace's environment already applied, the answer `Cache`, the
  `Settings`, and the event `Bus`. An effect requires what it uses through `yield*`; requiring
  anything outside the union fails to typecheck, which is what makes "no host imports"
  checkable rather than a matter of discipline.
- **Failures are values in the error channel.** On the capability surfaces the host handles any
  failure by its message (a failed card is a red card, a failed lookup contributes nothing), so
  those channels are `unknown` — fail with whatever typed error you like. Routes are the
  exception: their failures map to HTTP status codes, so they are typed as the taxonomy
  (`NotFoundError`, `BadRequestError`, …), exactly like the core's own routes.
- **Pure functions stay pure.** `applies` and `plan` are synchronous and receive plain data —
  the completion plan must be answerable before anything runs anyway.

Two ideas run through the model:

- **Additive, not slots.** There is no "the task board" for a workspace to name. The jira
  extension and the github-issues extension each contribute a wizard step, a card and a
  completion step, and a workspace that enables both gets both — two tickets on one change is a
  thing, not a conflict to arbitrate.
- **Enabled per workspace, resolved per request.** A workspace configures which extensions exist
  there; the answer is read live from the config on every request, which is why toggling one on
  the settings page takes effect at once. A workspace that names none has them all — which is
  what IWE was before extensions could be chosen.

## The surfaces

| Surface | API method | What it does |
|---|---|---|
| Dashboard card | `registerCard(card)` | A `Widget` per change, fetched on its own; optionally per-repository rows and actions. Effects requiring capabilities. |
| Wizard step | `registerWizardStep(step)` | A step in "Create change". `phase: "issue"` runs before the change details (it prefills the id and branch); `phase: "repos"` runs after the repositories are picked. |
| Provisioning | `on("change:created", handler)` | Runs when a change was created and its worktrees are in place — the git extension creates the worktrees here, jira assigns and moves its ticket. A failure is reported to the wizard under the extension's name and never fails the change. |
| Title sources | `registerTitleSource(source)` | Names changes on the overview after their ticket. Asked once per workspace; a source that cannot answer contributes nothing, so stored titles stand. |
| PR description | `registerDescriptionSection(section)` | A heading part, joined with the others into the description's first line. |
| Completion steps | `registerCompletionStep(step)` | Part of completing a change — planned up front, journaled like the core's steps, run after the merges and before the worktrees go. |
| Routes | `route(method, path, handler)` | Endpoints under `/api/ext/<name>/…`, behind the same origin guard as everything else, failures mapped to status codes by the same `runRoute` the core uses. |

Every hook receives a `ChangeContext` carrying the workspace the request runs as — subprocesses
started inside it inherit that workspace's environment, so a second client's `gh` or Jira token
is already the right one.

## What an extension looks like

Two files, one per half:

```
src/extensions/my-extension/
├── index.ts      # the server half: the factory, registered through the API
└── client.tsx    # the browser half, when the extension has a wizard step
```

```ts
// src/extensions/my-extension/index.ts
import { Effect } from "effect";
import { Shell, Cache, Workspace } from "../api.ts";

export default function (api: IweExtensionApi) {
  api.registerCard({
    title: "My extension",
    status: (change) =>
      Effect.gen(function* () {
        const shell = yield* Shell;          // subprocesses, workspace env applied
        const cache = yield* Cache;          // read-through with TTL
        const ws    = yield* Workspace;      // whose client this request is
        // … shell.run(["my-cli", …]) has the workspace's environment …
      }),
  });

  api.registerWizardStep({ id: "my-extension", title: "My step", phase: "repos" });

  api.route("GET", "/things", (req) =>
    Effect.gen(function* () {
      // fail with BadRequestError/NotFoundError/… and the status code is right
      return Response.json({ things: [] });
    }));
}
```

The client half exports `step`, a React component receiving the wizard's shared context — the
draft (id, branch) it may prefill, the repositories picked so far, the ticket label it may set,
and `setPayload(extension, data)`, which lands whatever the step picked on the change record
under the extension's own name, in the change's `extensions` bag. The core stores that bag and
never looks inside; the extension owns its shape and reads it back through `change.extensions`.

```tsx
// src/extensions/my-extension/client.tsx
export const step: StepComponent = ({ ctx }) => {
  // ctx.repos, ctx.draft, ctx.setDraft, ctx.setPayload, ctx.setTicket
};
```

Register it in `src/web/extensions.tsx`'s client registry and in `src/extensions/index.ts`'s
loader — two lines each, until extensions load dynamically.

Three rules keep the halves honest:

1. **The client half never imports the server half.** Shared types live in a `shared.ts` that
   imports nothing that runs.
2. **Everything crossing the boundary is JSON.** "Callbacks" are route calls.
3. **Refresh goes through the event stream.** The server announces what changed; components
   re-read, like every other card on the page.

## Data on a change

An extension's own facts about a change live in the change's `extensions` bag, keyed by
extension name:

```json
{ "extensions": { "jira": { "key": "PROJ-123" }, "github-issues": { "repo": "/repos/x", "number": 12 } } }
```

`change.jira` is legacy — where the jira extension's key was written before extensions existed —
and is still read; every change recorded before then carries it. New fields go in the bag.

## Enablement

```json
{
  "workspaces": [
    { "id": "client", "name": "Acme" },
    { "id": "personal", "name": "Personal",
      "extensions": ["git", "ci", "github-issues"] }
  ]
}
```

A workspace that names no `extensions` has all of them. Naming some is the whole list — there is
no subtraction, because a list you can read is worth more than a default you have to reason
about. The settings page renders one switch per discovered extension per workspace and writes
this key for you; a name nothing loaded answers for is reported when the settings are written.

One legacy exception: a workspace could already switch Jira off with `"jira": false`, and that
flag still excludes the jira extension while the workspace names no extensions. Once every
workspace that cares has named its extensions, the flag is history.

## Scope, honestly stated

- Extensions are **built-ins**: they ship with IWE, are imported statically, and get the host's
  capabilities through the R channel rather than by importing internals. `api.ts` is the whole
  promise — when out-of-tree extensions arrive, that is all they get.
- Deployments, terminals and the CI card's composition are still core code. They are candidates
  for the same treatment, not examples of it.
- There are no interception-style events yet (nothing can block or transform a core action).
  `change:created` and the contributed steps are the model; more events arrive when a second
  consumer needs them.

The plan that built this lives in `docs/extensions-plan.md`.
