# Extensions

> **Kind:** guide · **Status:** active

An extension is a piece of TypeScript that adds something to IWE — a dashboard card, a step in
the "Create change" wizard, a hook on the change lifecycle, a route, a source of titles for the
overview, a page of its own. It is the shape pi's extensions have: a module whose default export
**describes** what it contributes — a static value, or a factory returning one — so the host
wires it up from a registry instead of the core naming it by hand. An extension imports
`src/extension-host/api.ts`; the host never passes an API object in.

"Integration" is the wire spelling of "extension", used in `Widget.integration` (and its
out-of-tree client contract); everything else says extension.

Handlers are **Effects**, and that is the dependency-injection contract:

- **The host provides the capabilities** — the request's `Workspace` tag, a `Shell` for
  subprocesses with the workspace's environment already applied, the answer `Cache`, the
  `Settings`, the event `Bus`, the name-bound `ExtensionStore` for the extension's own data
  about a change, and the read-only `Changes` store (read a change, locate its git checkout and
  base branch, and read a legacy sidecar for migration).
  An effect requires what it uses through `yield*`; requiring anything outside
  the union fails to typecheck, which is what makes "no host imports" checkable rather than a
  matter of discipline.
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
  the settings page takes effect at once. A workspace that names none has them all.

## The surfaces

| Surface | Extension field | What it does |
|---|---|---|
| Dashboard card | `cards` | A `Widget` per change, fetched on its own; optionally per-repository rows and actions. Effects requiring capabilities. |
| Dashboard widget | `dashboardWidgets` | A client-drawn component on a change's dashboard. The client half exports `widget`, receiving the change and its workspace (below); for content with client state a server-drawn card cannot hold. |
| Wizard step | `wizardSteps` | A step in "Create change". `phase: "issue"` runs before the change details (it prefills the id and branch); `phase: "repos"` runs after the repositories are picked. |
| Lifecycle hooks | `events` | Before/after hooks on each change moment — `change:creating`/`change:created`, `change:completing`/`change:completed`, `change:cancelling`/`change:cancelled`. A before hook may transform a create or veto an operation; an after hook observes a committed change and never fails the operation (below). |
| Data store | `ExtensionStore` capability | This extension's own entry in the change's `extensions` bag, and the files under `extensions/<name>/` in the change directory. The core stays the only writer of `change.json` (below). |
| Title sources | `titleSources` | Names changes on the overview after their ticket. Asked once per workspace; a source that cannot answer contributes nothing, so stored titles stand. |
| Summary contributions | `summaryContributions` | Facts on a change's overview card, merged by the host into the one summary it renders; a contribution's `state`, when given, is its verdict for the navigation icon, which takes the worst offered. |
| Loose ends | `looseEnds` | What cancelling the change would leave behind — the open ticket, the open pull requests — asked when the cancel is confirmed. |
| Window presenters | `windowPresenters` | How a tmux window is named and drawn. Pure functions of tmux data, global rather than per-workspace (below). |
| Pages | `pages` | A page of the extension's own, served at `/{id}` and offered by the sidebar (below). |
| Change tabs | `changeTabs` | A tab on a change's page, beside the core's Dashboard. The client half exports `tab`, a component receiving the change and its workspace (below); the review extension is the change-tab example, and the notes extension pairs a widget with the `ExtensionStore`. |
| Per-workspace settings | `workspaceSettings` | Configuration the extension declares per context, rendered by the settings page for every workspace that has the extension enabled (below). |
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

## Lifecycle events

Every change moment comes in a pair: a **before** hook that runs before the core commits the
operation and may transform or veto it, and an **after** hook that runs once the change exists
and only observes.

| Moment | Before (may transform or veto) | After (observer, never fails) |
|---|---|---|
| Create | `change:creating` | `change:created` |
| Complete | `change:completing` | `change:completed` |
| Cancel | `change:cancelling` | `change:cancelled` |

A **before** hook on creation receives the plain `ChangeDraft` (id, branch, repos, direct, base,
workspace, extensions) and returns a patch (`Partial<ChangeDraft>`) or nothing. Hooks run in
extension load order and chain — each sees the previous hook's result — and the core applies the
result and then re-runs every invariant (id shape, non-empty repositories, valid state
transition) before writing. An extension may suggest, never bypass. Failing with the taxonomy
vetoes the create, and the message is shown where the create was started. A `change:creating`
hook runs before the change directory exists, so a creator that needs files writes them in
`change:created`.

`change:completing` and `change:cancelling` receive the `Change` — there is no draft to patch —
and veto by failing. They run before any irreversible step (the merges, the worktree removal), so
a veto leaves the change exactly as it was.

`change:created`, `change:completed` and `change:cancelled` run once the core has committed
(`change.json` written, and archived for the finished states). A failure is reported under the
extension's name and never fails the operation, exactly as `change:created` provisioning has
always behaved: the results are collected, and a failed hook stops the rest of its own
extension's hooks but no other extension's. The change page shows those failures as one error
banner per extension (`<extension>: <error>`): creation's where the create was started, and a
completion's or cancellation's on the page that performed it. A successful observer says
nothing.

Enablement is resolved per workspace at the moment of the event, like every other surface. Each
hook runs as that workspace and with the contributing extension's name bound into its
`ExtensionStore`. **Planned completion steps stay separate**: they live on `completionSteps`,
are named in the journal before anything runs and can stop it, and they are deliberately not
reachable through the events map — so there are not two ways to hang work off a completion with
different failure semantics.

## The overview

The summary a change's card on the overview carries is contributed facts. Each contributor
answers with facts — a coloured dot and a phrase, the dashboard's own vocabulary — and, when it
has an opinion, a verdict for the change's status icon. The host merges every answer into the
one `{ facts, state }` the card renders: the core contributes the terminals fact (tmux stays
core), the github extension the review facts (unresolved comments, the checks verdict) and the
azure-devops extension the pipeline facts (pipelines active). The core's fact leads, and the
extension facts follow in load order, so the terminals
line reads first even when pipelines are active. The navigation icon takes the worst verdict
offered. A failed contribution contributes nothing.

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
answers with the open ticket, github with the open pull requests; one string per end, phrased for
a person, merged into the confirmation the cancel dialog has always shown. The ends follow
extension load order, so the pull requests come before the ticket; the set of sentences is
unchanged. A failed
contribution contributes nothing.

## Pages

A page is `/{id}` in the app — the Azure DevOps page is `/azure-devops`, the leftovers page is
`/leftovers`. An extension declares
its pages (`{ id, title }`), and the sidebar offers what `GET /api/pages?workspace=…` says
exists, exactly as the wizard already does with steps: the page exists for a workspace when
the extension does, and a disabled extension's page is not offered, not an empty one.

The page's content is the extension's client half exporting `page`, a component receiving the
workspace it is open on. Built-ins sit in the page's own registry; out-of-tree pages load from
the served chunk, under the same contract as steps (below).

## Change tabs

A change's page is a row of tabs: the core's Dashboard, and whatever the change's
workspace's extensions contribute — the review extension's "Review changes" is the built-in
example. An extension
declares its tabs (`{ id, title }`), and the page asks `GET /api/changes/:id/tabs` for them —
exactly as the sidebar asks `/api/pages`, and the wizard `/api/wizard`. The tab exists for a
change when the extension does in the change's workspace, and a disabled extension's tab is not
offered, not an empty one.

A tab id is the tab's identity on that route and in the change's URL, so two extensions cannot
both own one: across a workspace's extensions the first in load order keeps the id, and a later
extension's tab under the same id is skipped — the same rule that makes a duplicate extension
name a no-op. The core's own `dashboard` and `terminals` ids are reserved: a
contributed tab that would shadow one is dropped.

The tab's content is the extension's client half exporting `tab`, a component receiving the
change it is about (`{ change, workspace? }`) — distinct from `page`, which receives only the
workspace. Built-ins sit in the page's registry; out-of-tree tabs load from the served chunk,
under the same contract as steps and pages (below).

## Dashboard widgets

A change's dashboard holds two kinds of card: the server-drawn cards (`cards` above — a `Widget`
per change, polled every 15 seconds) and the client-drawn widgets here. An extension declares
its widgets (`{ id, title, wide? }`), and the page asks `GET /api/changes/:id/widgets` for
them — the same question as tabs, one surface over. The widget exists for a change when the
extension does in the change's workspace, and a disabled extension's widget is not offered, not
an empty one.

A widget is for content with client state a server-drawn card cannot hold: the notes
textarea's debounce, its unsaved marker, never overwriting what is being typed. The content is
the extension's client half exporting `widget`, a component receiving the same
`{ change, workspace? }` a tab gets. Widgets carry no address — the page keys them by extension
plus id — so two extensions may each draw one under the same id, and there are no reserved
ids. Narrow widgets render after the narrow cards, wide ones after the wide cards.

## What an extension looks like

A module whose default export **describes** the extension — a static value when everything is
known up front (most extensions), or a factory returning it from an Effect when startup needs
to compute (check a CLI exists, read a file, decide conditionally). A failed factory is an
extension absent, with the error logged — a broken optional plugin does not take the dashboard
down.

```
src/extensions/my-extension/
├── index.ts      # the server half: the description, or a factory for it
└── client.tsx    # the browser half, when the extension has a wizard step, a page, a change tab or a dashboard widget
```

```ts
// src/extensions/my-extension/index.ts
import { Effect } from "effect";
import { Shell, Cache, Workspace, type Extension } from "../../extension-host/api.ts";

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
    if (!settings.notificationSound) return { name: "my-extension", title: "My extension" };
    return { name: "my-extension", title: "My extension", cards: [/* … */] };
  });
```

The client half exports `step`, a React component receiving the wizard's shared context — the
draft (id, branch) it may prefill, the repositories picked so far, the ticket label it may set,
and `setPayload(extension, data)`, which lands whatever the step picked on the change record
under the extension's own name, in the change's `extensions` bag. The core stores that bag and
never looks inside; the extension owns its shape and reads it back through `change.extensions`.
An extension that offers a page exports `page` from the same half instead — a component
receiving the workspace the page is open on (below) — one that adds a change tab exports
`tab`, a component receiving the change (below), and one that draws on the dashboard exports
`widget`, receiving the change the same way (above).

```tsx
// src/extensions/my-extension/client.tsx
export const step: StepComponent = ({ ctx }) => {
  // ctx.repos, ctx.draft, ctx.setDraft, ctx.setPayload, ctx.setTicket
};
```

A built-in registers its halves in two places — the loader (`src/extension-host/index.ts`) and, when
it has a step, a page, a change tab or a dashboard widget, the page's client registry (`src/extension-host/client.tsx`).
An out-of-tree
extension registers nowhere: it is discovered from the config and loaded through the same
install path (below).

Three rules keep the halves honest:

1. **The client half never imports the server half.** Shared types live in a sibling file (an
   extension's own `shared.ts`, say) that imports nothing that runs.
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
changes with the extension's address; `src/extension-host/api.ts` is still the whole promise. Loading happens
once, at startup, so a change to the paths needs a restart.

A discovered module's **client half** is the sibling `client.tsx`, when it exists. The page
cannot bundle it — it was written after the page was built, or changes without one — so the
server builds it at startup (Bun.build, react and its jsx runtimes external) into the XDG state
directory and serves it at `GET /extensions/<name>/client.js`. The wizard's step host imports
that URL at runtime when a step's extension has no static entry in the page's registry, and the
page host does the same for a page — one chunk serves a step, a page, a change tab or a
dashboard widget, whichever of `step`, `page`, `tab` and `widget` the module exports.

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

`change.jira` holds the jira extension's key on changes recorded before the `extensions` bag
existed. It is no longer part of the core's `Change` type, but both `change.json` and the config
file decode with unknown keys preserved, so the field is still there at runtime and the jira
extension reads it through its own `src/extensions/jira/legacy.ts` — the one place that names it,
with `extensions.jira` tried first. New fields go in the bag. The core no longer copies a legacy
`jira` field posted to `POST /api/changes`: an old client that wants the ticket recorded posts it
under `extensions.jira`, and a bare `jira` is dropped rather than written.

An effect that needs to *wander* that bag, or keep files beside it, uses the **`ExtensionStore`**
capability rather than touching `change.json`. The host provides it per contribution with the
extension's name already bound, so an effect says `store.write(change, "notes.md", text)` and
lands in `extensions/<name>/notes.md` without naming itself:

```ts
import { Effect } from "effect";
import { ExtensionStore } from "../../extension-host/api.ts";

Effect.gen(function* () {
  const store = yield* ExtensionStore;
  const saved = yield* store.update(change, { reviewed: true }); // this extension's bag entry
  yield* store.write(saved, "notes.md", "what I found");
  return yield* store.list(saved);
});
```

`update` replaces this extension's own entry in the change's `extensions` bag and writes
`change.json` once; `read`, `write` and `list` work on files under `extensions/<name>/`, created
on demand and confined to that directory (a path that escapes it is rejected). All of them
resolve the change's *current* location, so they keep working after `archiveChange` moves the
directory. `change.json`, `wt.toml` and the core's own sidecars are not reachable through it.
The capability exists wherever a committed change does — after-hooks, planned completion steps,
cards, routes — and a `change:creating` hook has no directory yet, so it writes files in
`change:created`.

The **notes extension** is the worked example: its dashboard widget reads and writes
`extensions/notes/notes.md` through the store, and no core route or card touches notes any more.
A change whose notes predate the store still shows them, through one deliberately narrow read on
the `Changes` capability: `readSidecar(change, name)` returns a legacy file from the change root
by bare filename — no path separators, and not one of the core's own change-root files — and ""
when it is refused, absent or unreadable, so the store is tried first and the legacy sidecar is
the fallback. The core's `change.json`, `wt.toml` and `completion.json` are refused by name, so
the read cannot be turned on the change record or the completion journal. That is **migration
access, not a general escape hatch**: new data always goes to `ExtensionStore`, a write never
touches the legacy file, and the bare-filename scope exists only for data a former feature wrote
at the change root. There is no removal plan yet; new migrations should get their own narrow read
rather than widening this one.

## Enablement

```json
{
  "workspaces": [
    { "id": "client", "name": "Acme" },
    { "id": "personal", "name": "Personal",
      "extensions": ["git", "github", "github-issues"] }
  ]
}
```

A workspace that names no `extensions` has all of them. Naming some is the whole list — there is
no subtraction, because a list you can read is worth more than a default you have to reason
about. The settings page renders one switch per discovered extension per workspace and writes
this key for you; a name nothing loaded answers for is reported when the settings are written.
Retired names migrate on load and on every settings write (`migrateExtensionSettings` in
src/extension-host/migrate.ts): `ci` becomes `github` + `azure-devops`, `deployments` becomes
`azure-devops`, the `deployments` bags move to `azure-devops`, and a legacy per-workspace
`azure` object (`false`, or `{ organization, project }`) folds into the same bag — `false`
additionally materializing an explicit list without `azure-devops`, since naming some is the
whole list. The legacy flat `azureOrganization`/`azureProject`/`azureDeploy` fields stay
readable through the extension's own `legacy.ts` until that fallback is removed.

## Per-workspace settings

An extension that wants per-workspace configuration declares it, and the core renders it: flat
string fields under `workspaceSettings`, shown on the settings page for every workspace that has
the extension enabled, stored under the workspace's `extensionSettings[name][key]`. The core
carries that bag without looking inside — what belongs there is the extension's own declaration,
and the extension reads it back from the request's `Workspace` tag (the jira extension's
`siteOfWorkspace` is the model; it reads `extensionSettings.jira` first and falls back to a
legacy `workspace.jira` object through its own `legacy.ts`). The azure-devops extension is the
other worked example: it declares `workspaceSettings` for organisation and project, and its
`azure.ts` reads them
back as the first step of its chain — a per-workspace override the page can write, with the
legacy `workspace.azure` object and the global settings as the fallbacks below it.

## Global settings

A server-wide thing is configured once, not per context. An extension declares its
server-wide settings under `globalSettings` — the same flat fields, plus a `list` flag that
edits a list of strings as rows — and the settings page renders them in a section per
extension, for every workspace. They are stored under the `extensionSettings[name][key]` bag at
the top level of the config file, not under any workspace.

The environment override story is declared too: a setting whose declaration names an `env`
variable is shown locked when that variable is set, with the variable named — the page cannot
fight it. The precedence is the same for every setting: the extension's bag (what the page or
the file wrote) wins, and when the bag holds nothing the flat config field answers, which carries
the default and the environment resolution — so an environment variable still wins unless the
page wrote the field, which is why the page locks it while the variable is set. A field the core
no longer types is the extension's own read: the jira extension's `globalOf` falls back to the
legacy `jiraAssignee`/`jiraStartTransition`/`jiraDoneTransition` fields through its own
`legacy.ts`, keeping the config's environment resolution, and nothing in the core names them.
The azure-devops extension's `legacy.ts` does the same for the retired `azureOrganization`,
`azureProject` and `azureDeploy` fields, read from the file rather than the resolved config.
Empty means unset, for a string and for a list alike: an emptied list is written to the config
as `[]`, and readers
(like the azure-devops settings' `bagList`) treat that as unset.

## Scope, honestly stated

- Extensions ship as **built-ins** and as **out-of-tree modules** (above). Both install through
  the same path and get the host's capabilities through the R channel. The built-ins are
  **first-party**: imported statically, they may still reach into core modules and
  `src/vendors/` while they live in this repository, but new built-in code uses
  `src/extension-host/api.ts` plus `src/domain/`, so the privilege shrinks by default. The
  first-party exceptions are listed rather than assumed: the leftovers page reads the changes
  root through `change/server/index.ts`; the azure-devops settings read the config file through
  `workspace/server/config.ts` for their legacy fallback; and the jira legacy shim reads the one
  settings precedence chain through `settings/server/legacySettings.ts`, the documented leaf.
  Out-of-tree modules import only `src/extension-host/api.ts` — the whole promise — and never get
  the privilege. There is no stability promise for them yet. The github and azure-devops
  extensions already run their `az`/`gh` calls through the contract's `Shell`, `Cache`,
  `Settings` and `Changes` capabilities.
- What remains core is what everything else stands on: **tmux and ttyd session handling
  themselves** (what surrounds them — names, icons, status — is the extensible part), the **git
  worktree engine**, the **change lifecycle** (create, complete, cancel), and the **page
  shell**. The Azure DevOps page, the overview's summary, cancelling's loose ends and the
  terminal presentation have all moved behind the surfaces above.
- Lifecycle events are interception-style where the moment allows it: the `change:creating`,
  `change:completing` and `change:cancelling` before-hooks can transform or veto a core action,
  and the core re-runs its own invariants after any transform. Planned completion steps stay
  separate from the events map. More moments arrive as pairs, when a second consumer needs them.
- An extension's own data about a change has one writer: the core writes `change.json`, and the
  extension writes through `ExtensionStore` — its bag entry, and the files under its namespaced
  directory. Nothing else reaches `change.json`.

See [`../plans/archive/extensions-plan.md`](../plans/archive/extensions-plan.md) and
[`../plans/archive/extensions-migration-plan.md`](../plans/archive/extensions-migration-plan.md)
for the plans behind these surfaces, and [`architecture.md`](architecture.md) for the core
structure they attach to.
