# Extensions

> **Kind:** guide · **Status:** active

An extension is a piece of TypeScript that adds something to IWE — a dashboard card, a step in
the "Create change" wizard, a hook that runs when a change is created, a route, a source of
titles for the overview, a page of its own. It is the shape pi's extensions have: a module whose
default export is a factory receiving an API object, contributing to registries instead of being
wired in by hand.

"Integration" is the legacy spelling of "extension", retained only in `Widget.integration` on
the wire (and its out-of-tree client contract); everything else says extension.

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

| Surface | Extension field | What it does |
|---|---|---|
| Dashboard card | `cards` | A `Widget` per change, fetched on its own; optionally per-repository rows and actions. Effects requiring capabilities. |
| Wizard step | `wizardSteps` | A step in "Create change". `phase: "issue"` runs before the change details (it prefills the id and branch); `phase: "repos"` runs after the repositories are picked. |
| Provisioning | `events["change:created"]` | Runs when a change was created and its worktrees are in place — the git extension creates the worktrees here, jira assigns and moves its ticket. A failure is reported to the wizard under the extension's name and never fails the change. |
| Title sources | `titleSources` | Names changes on the overview after their ticket. Asked once per workspace; a source that cannot answer contributes nothing, so stored titles stand. |
| Summary contributions | `summaryContributions` | Facts on a change's overview card, merged by the host into the one summary it renders; a contribution's `state`, when given, is its verdict for the navigation icon, which takes the worst offered. |
| Loose ends | `looseEnds` | What cancelling the change would leave behind — the open ticket, the open pull requests — asked when the cancel is confirmed. |
| Window presenters | `windowPresenters` | How a tmux window is named and drawn. Pure functions of tmux data, global rather than per-workspace (below). |
| Pages | `pages` | A page of the extension's own, served at `/{id}` and offered by the sidebar (below). |
| Global settings | `globalSettings` | Server-wide settings the extension declares, rendered by the settings page in a section per extension (below). |
| PR description | `descriptionSections` | A heading part, joined with the others into the description's first line. |
| Completion steps | `completionSteps` | Part of completing a change — planned up front, journaled like the core's steps, run after the merges and before the worktrees go. |
| Routes | `routes` | Endpoints under `/api/ext/<name>/…`, behind the same origin guard as everything else, failures mapped to status codes by the same `runRoute` the core uses. Paths may carry `:name` segments (below). |

Every hook runs as the request's workspace — the `Workspace` capability the host provides — so
subprocesses started through its `Shell` inherit that workspace's environment, and a second
client's `gh` or Jira token is already the right one.

**Routes take path parameters.** A declared `path` may carry `:name` segments, each capturing
one segment of the request path into `params["name"]` — `/services/:service/versions` answers
for `/services/example-service/versions` with `params.service === "example-service"`. Matching
tries the extension's patterns in registration order, then the next extension in load order;
the first pattern whose shape fits wins. Handlers receive `(req, params)`, and one that only
takes `req` stays assignable as it is — a function with fewer parameters is one with more.

## The overview

The summary a change's card on the overview carries is contributed facts. Each contributor
answers with facts — a coloured dot and a phrase, the dashboard's own vocabulary — and, when it
has an opinion, a verdict for the change's status icon. The host merges every answer into the
one `{ facts, state }` the card renders: the core contributes the terminals fact (tmux stays
core), the ci extension the vendor facts — pipelines active, unresolved comments, the CI
verdict. The core's fact leads, and the extension facts follow in load order, so the terminals
line reads first even when pipelines are active. The navigation icon takes the worst verdict
offered, exactly as it took the worst of
the core's own states before. A failed contribution contributes nothing.

## Terminal windows

The core presents every tmux window the way the sidebar and the terminal strips draw it: a
name, an icon, whether it counts as work happening. Extensions contribute **presenters** to
say what a window is: which pane options to read for it, and what those options mean — pure
functions of tmux data in, a presentation out. The first presenter that answers a field wins;
fields left out fall through to the next presenter, and the core's defaults compose last, so
the label is still a good one when a presenter only says what is running.

Presenters are **global, not per-workspace**, on purpose: they run no effects, and a window's
name cannot depend on whose client happens to be looking. Enablement stays for the surfaces
that do things. The `agents` extension is the worked example: pi's own `busy-title` extension
sets `@agent working` (or `waiting`) on its pane, the agents extension reads that option and
answers for those windows — `pi working`, an agent icon, green while it works — and the core
never parses `@agent` at all; it only carries the pane options presenters declare.

The page renders what the server sends. `GET /api/terminals` and the terminal windows routes
carry the presented shape — `{ index, label, detail, icon?, state?, busy?, active, activity }`
— and
the page-side label composition (`windowLabel`) is gone: the server says what a window is
called. The `busy` field is sent for the overview summary's use, not rendered by the page.

## Cancelling

Cancelling a change asks the contributors what it would leave behind. The jira extension
answers with the open ticket, ci with the open pull requests; one string per end, phrased for
a person, merged into the confirmation the cancel dialog has always shown. The ends follow
extension load order, so the pull requests come before the ticket; the set of sentences is
unchanged. A failed
contribution contributes nothing.

## Pages

A page is `/{id}` in the app — the deployments page is `/deployments`. An extension declares
its pages (`{ id, title }`), and the sidebar offers what `GET /api/pages?workspace=…` says
exists, exactly as the wizard already does with steps: the page exists for a workspace when
the extension does, and a disabled extension's page is not offered, not an empty one.

The page's content is the extension's client half exporting `page`, a component receiving the
workspace it is open on. Built-ins sit in the page's own registry; out-of-tree pages load from
the served chunk, under the same contract as steps (below).

## What an extension looks like

A module whose default export **describes** the extension — a static value when everything is
known up front (most extensions), or a factory returning it from an Effect when startup needs
to compute (check a CLI exists, read a file, decide conditionally). A failed factory is an
extension absent, with the error logged — a broken optional plugin does not take the dashboard
down.

```
src/extensions/my-extension/
├── index.ts      # the server half: the description, or a factory for it
└── client.tsx    # the browser half, when the extension has a wizard step or a page
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
An extension that offers a page exports `page` from the same half instead — a component
receiving the workspace the page is open on (below).

```tsx
// src/extensions/my-extension/client.tsx
export const step: StepComponent = ({ ctx }) => {
  // ctx.repos, ctx.draft, ctx.setDraft, ctx.setPayload, ctx.setTicket
};
```

A built-in registers its halves in two places — the loader (src/extensions/index.ts) and, when
it has a step or a page, the page's client registry (src/web/extensions.tsx). An out-of-tree
extension registers nowhere: it is discovered from the config and loaded through the same
install path (below).

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
that URL at runtime when a step's extension has no static entry in the page's registry, and the
page host does the same for a page — one chunk serves a step, a page, or both, whichever of
`step` and `page` the module exports.

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
The legacy vendor flags no longer participate in enablement: the `extensions` list is the whole
story, and the settings page writes it. `"azure": false` is still read where it states a fact —
"this context has no pipelines" — by `usesAzure`/`azureOf` (src/workspaces.ts) and the workspace
card, but it never rewrites the list. Naming some is the whole list, and a list you can read is
worth more than flags nothing reads anymore.

## Per-workspace settings

An extension that wants per-workspace configuration declares it, and the core renders it: flat
string fields under `workspaceSettings`, shown on the settings page for every workspace that has
the extension enabled, stored under the workspace's `extensionSettings[name][key]`. The core
carries that bag without looking inside — what belongs there is the extension's own declaration,
and the extension reads it back from the request's `Workspace` tag (the jira extension's
`siteOfWorkspace` is the model).

## Global settings

A server-wide thing is configured once, not per context. An extension declares its
server-wide settings under `globalSettings` — the same flat fields, plus a `list` flag that
edits a list of strings as rows — and the settings page renders them in a section per
extension, for every workspace. They are stored under the `extensionSettings[name][key]` bag at
the top level of the config file, not under any workspace.

The environment override story is declared too: a setting whose declaration names an `env`
variable is shown locked when that variable is set, with the variable named — the page cannot
fight it. The precedence is the one every migrated setting follows: the extension's bag (what
the page or the file wrote) wins, and when the bag holds nothing the legacy config field
answers, which carries the default and the environment resolution — so an environment variable
still wins unless the page wrote the field, which is why the page locks it while the variable
is set. Empty means unset, for a string and for a list alike: an emptied list is written to
the config as `[]`, and readers (like the deployments settings' `bagList`) treat that as unset.

## Scope, honestly stated

- Extensions ship as **built-ins** and as **out-of-tree modules** (above). The built-ins are
  imported statically and get the host's capabilities through the R channel rather than by
  importing internals; the out-of-tree ones are imported from disk through the same install
  path and get the same capabilities, because they run in the same process. `api.ts` is the
  whole promise either way — its exports are all an extension may import.
- What remains core is what everything else stands on: **tmux and ttyd session handling
  themselves** (what surrounds them — names, icons, status — is the extensible part), the **git
  worktree engine**, the **change lifecycle** (create, complete, cancel), and the **page
  shell**. The deployments page, the overview's summary, cancelling's loose ends and the
  terminal presentation have all moved behind the surfaces above.
- There are no interception-style events yet (nothing can block or transform a core action).
  `change:created` and the contributed steps are the model; more events arrive when a second
  consumer needs them.

The plan that built this lives in [`../plans/archive/extensions-plan.md`](../plans/archive/extensions-plan.md);
the plan that moved the rest of the core behind it lives in
[`../plans/extensions-migration-plan.md`](../plans/extensions-migration-plan.md).
