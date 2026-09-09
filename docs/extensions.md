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

A module whose default export **describes** the extension — a static value when everything is
known up front (most extensions), or a factory returning it from an Effect when startup needs
to compute (check a CLI exists, read a file, decide conditionally). A failed factory is an
extension absent, with the error logged — a broken optional plugin does not take the dashboard
down.

```
src/extensions/my-extension/
├── index.ts      # the server half: the description, or a factory for it
└── client.tsx    # the browser half, when the extension has a wizard step
```

```ts
// src/extensions/my-extension/index.ts
import { Effect } from "effect";
import { Shell, Cache, Workspace, type Extension } from "../api.ts";

export default {
  name: "my-extension",
  title: "My extension",

  cards: [
    {
      title: "My extension",
      status: (change) =>
        Effect.gen(function* () {
          const shell = yield* Shell;          // subprocesses, workspace env applied
          const cache = yield* Cache;          // read-through with TTL
          const ws    = yield* Workspace;      // whose client this request is
          // … shell.run(["my-cli", …]) has the workspace's environment …
        }),
    },
  ],

  wizardSteps: [{ id: "my-extension", title: "My step", phase: "repos" }],

  routes: [
    { method: "GET", path: "/things", handler: (req) =>
        // fail with BadRequestError/NotFoundError/… and the status code is right
        Effect.succeed(Response.json({ things: [] })) },
  ],
} satisfies Extension;
```

A factory is the same shape behind a function, run once at startup with the *startup*
capabilities (everything but the request `Workspace`, which does not exist yet — load-time
`Shell` runs with the default workspace's environment):

```ts
export default () =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    if (!settings.azureOrganization) return { name: "my-extension", title: "My extension" };
    return { name: "my-extension", title: "My extension", cards: [/* … */] };
  });
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

A built-in registers its halves in two places — the loader (src/extensions/index.ts) and, when
it has a step, the page's client registry (src/web/extensions.tsx). An out-of-tree extension
registers nowhere: it is discovered from the config and loaded through the same install path
(below).

Three rules keep the halves honest:

1. **The client half never imports the server half.** Shared types live in a `shared.ts` that
   imports nothing that runs.
2. **Everything crossing the boundary is JSON.** "Callbacks" are route calls.
3. **Refresh goes through the event stream.** The server announces what changed; components
   re-read, like every other card on the page.

## Out-of-tree extensions

An extension does not have to live in this repository. The config file gains a list of paths:

```json
{
  "extensionPaths": ["~/exts/my-extension", "~/exts/other/index.ts"]
}
```

Each path is a `.ts` module file, or a directory — a directory contributes its immediate `.ts`
files plus any `*/index.ts`, in directory order. `~` is expanded and duplicates are ignored;
`~/.config/iwe/extensions/` is searched in addition, when it exists, without being configured.
The environment variable `IWE_EXTENSION_PATHS` (comma-separated) wins over the file — an empty
value counts as unset — and the settings page edits the file's list.

After the built-ins load, each discovered module is imported from disk and its default export
runs through the same install/factory path: a static description installs as-is, a factory runs
once with the startup capabilities. Every failure — a missing file, a module that throws on
import, one without a default export, a failed factory — is logged and skipped: a broken
optional extension is an extension absent, never a failed server. Nothing about the contract
changes with the extension's address; `api.ts` is still the whole promise. Loading happens
once, at startup, so a change to the paths needs a restart.

A discovered module's **client half** is the sibling `client.tsx`, when it exists. The page
cannot bundle it — it was written after the page was built, or changes without one — so the
server builds it at startup (Bun.build, react and its jsx runtimes external) into the XDG state
directory and serves it at `GET /extensions/<name>/client.js`. The wizard's step host imports
that URL at runtime when a step's extension has no static entry in the page's registry.

So that the served chunk and the page run one react — two reacts break hooks and context — the
server also builds vendor chunks once from the app's own react entrypoints and serves them at
`/vendor/react.js`, `/vendor/react-dom.js`, `/vendor/react-jsx-runtime.js` and
`/vendor/react-dom-client.js`, and the page carries an import map mapping `react`,
`react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom` and `react-dom/client` to those URLs.
The page's own bundle resolves react at build time and never consults the map; it is the served
chunks' bare specifiers that resolve through it.

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
The legacy `"jira": false` flag is retired: `migrateWorkspaceSettings` (src/extensions/index.ts)
folds it into an explicit extensions list — everything loaded except jira — on load and on every
settings write, along with the legacy `jira` object, whose fields land under
`extensionSettings.jira`.

## Per-workspace settings

An extension that wants per-workspace configuration declares it, and the core renders it: flat
string fields under `workspaceSettings`, shown on the settings page for every workspace that has
the extension enabled, stored under the workspace's `extensionSettings[name][key]`. The core
carries that bag without looking inside — what belongs there is the extension's own declaration,
and the extension reads it back from the request's `Workspace` tag (the jira extension's
`siteOfWorkspace` is the model).

## Scope, honestly stated

- Extensions ship as **built-ins** and as **out-of-tree modules** (above). The built-ins are
  imported statically and get the host's capabilities through the R channel rather than by
  importing internals; the out-of-tree ones are imported from disk through the same install
  path and get the same capabilities, because they run in the same process. `api.ts` is the
  whole promise either way — its exports are all an extension may import.
- Deployments, terminals and the CI card's composition are still core code. They are candidates
  for the same treatment, not examples of it.
- There are no interception-style events yet (nothing can block or transform a core action).
  `change:created` and the contributed steps are the model; more events arrive when a second
  consumer needs them.

The plan that built this lives in `docs/extensions-plan.md`.
