# Extensions: plan for the task-board slice

The extension model, decided in discussion: extensions are built-in TypeScript modules that
contribute to **host surfaces** (additive; no vendor-category interfaces in the API), are
**enabled per workspace** (absent `extensions` key = all built-ins, which is today's behaviour),
and may ship a **frontend half** — a React component loaded by the page through a client
registry. Out-of-tree loading, interception-style events, and the other capabilities
(deployments, terminals, CI composition) are deliberately out of scope for this slice.

The slice: task boards. Two implementations — **jira**, migrated out of the core unchanged, and
**github-issues**, new, so the whole thing is developable and testable on a machine without Jira.

## The surface list (this slice)

| Surface | Extension API | Today's hardcoded home |
|---|---|---|
| Dashboard card (+ per-repo rows, actions) | `registerCard()` | `integrations/index.ts` record |
| Wizard step | `registerWizardStep()` | `Wizard.tsx` (Jira step) + `/api/jira/issues` |
| Provision on create | `on("change:created")` | `provisionEffect` loops `Integration.provision` |
| Completion steps | `registerCompletionSteps()` | `complete.ts` (jira move step) |
| Title sources | `registerTitleSource()` | `titles.ts` → `issuesByKeysEffect` |
| PR-description sections | `registerDescriptionSection()` | `description.ts` → `issueByKeyEffect` |
| Routes | `registerRoute()` | `server.ts` route table |
| Events | `on(...)` | — (only `change:created` until a second consumer appears) |

Everything else stays hardcoded: deployments, terminals, the CI card's composition
(github.ts + azure.ts internals), `summary.ts`'s pipeline counts, the settings page's Jira/Azure
fields. `extensions/agent-state.ts` (the pi extension) is untouched.

## Steps

### 1. Extension API and loader

- `src/extensions/api.ts` — the types an extension may import: `IweExtensionApi` with the
  register methods above, plus the shared payload types (`Card` = today's `Integration` shape,
  `WizardStep`, `CompletionStep`, …).
- `src/extensions/index.ts` — the loader: a static list of built-ins, each called with an API
  implementation; exposes the registries and `extensionsFor(workspace)` (the resolution rule:
  `workspace.extensions` when set, all built-ins otherwise, in registration order).
- Move the `git` and `ci` card objects into `src/extensions/git/index.ts` and
  `src/extensions/ci/index.ts`, registering through the API. `integrations/index.ts` shrinks to
  reading from the registry.

**Done when:** behaviour identical, `bun test` green, cards served from the registry.

### 2. Hook surfaces in the core (still only jira behind them)

- `provisionEffect` calls `change:created` listeners instead of `Integration.provision`; results
  keep the `{ extension, ok, error }` shape the wizard already displays.
- `complete.ts` merges its own core steps (merge PRs) with steps contributed via
  `registerCompletionSteps(change)` — ordered after the core's, same `CompletionStep` shape and
  write-as-they-happen progress.
- `titles.ts` and `description.ts` ask the registry: a title source gets the changes it may know
  about and returns what it knows (first contributor that answers a change wins); a description
  section appends to the composed text.
- New route namespace `/api/ext/:name/*`, registered through the API, subject to the same origin
  guard as the rest.

**Done when:** the jira call sites (`moveIssueEffect`, `issuesByKeysEffect`, `issueByKeyEffect`)
are no longer imported outside the jira extension.

### 3. The jira extension (pilot migration, behaviour-preserving)

- `src/extensions/jira/index.ts` — the server half: everything now in `src/integrations/jira.ts`
  (+ `jiraHttp.ts`), registered through the API: card, provision hook, title source, description
  section, completion step ("move <key> to Done"), `move` action, issue-list/create routes.
- Keeps the `change.jira` field: it is this extension's field, already recorded on archived
  changes. New extensions use a namespaced bag (`change.extensions["github-issues"]`); vendor
  fields at the top level are legacy.
- `test/jira.test.ts`, `test/provision.test.ts` keep passing (imports updated).

**Done when:** a Jira-configured flow is indistinguishable from today's, per the existing tests.

### 4. The frontend surface

- `src/web/extensions.ts` — the client registry, mirroring the server one, as build-time dynamic
  imports: `{ jira: () => import("../../extensions/jira/client.tsx"), ... }`. When out-of-tree
  extensions arrive this becomes a fetch of a server-built chunk; the contract stays.
- `src/extensions/jira/client.tsx` — `IssueTable` + the new-issue dialog move here, exported as
  the jira wizard step component.
- `StepHost` + a wizard context in `Wizard.tsx`: steps render through the host and get
  `{ workspace, draft, setDraft, repos, setPayload }` — the shared draft (id, branch) is what
  lets a step sitting *after* the repository step still prefill the change id and branch.
- `GET /api/wizard?workspace=…` returns the enabled steps as data:
  `[{ id, extension, title }]`. The jira issue routes move under `/api/ext/jira/…`.
- Dashboard cards need nothing: `Widget`/`WidgetItem` already crosses as data.

**Done when:** the wizard renders its Jira step from the extension's client component, with no
`jira` name left in `Wizard.tsx`.

### 5. The github-issues extension (the new one)

- `src/extensions/github-issues/index.ts` — server half on `gh` (REST/GraphQL through the
  existing helpers in `integrations/github.ts` where they fit: `repoFromUrl`, readiness):
  - **Wizard step** (registered after the repository step): open issues across the selected
    repositories, pick one or create one (`gh issue create`); picked issue prefills the draft and
    lands in `change.extensions["github-issues"]`.
  - **Card**: issue state, labels, assignee via `Widget`.
  - **Title source**: `owner/repo#123` titles.
  - **Description section**: the issue reference and summary.
  - **Completion step**: close the issue with a comment linking the merged work.
- `src/extensions/github-issues/client.tsx` — the step component: an issue list for the selected
  repos plus a create dialog (the jira step's shape, different data).
- It degrades honestly: repositories without a GitHub remote contribute a "not a GitHub
  repository" row rather than pretending.

**Done when:** on this machine (no Jira), a change can be created from a GitHub issue, followed
on the dashboard, and completed — with the jira extension disabled for the workspace.

### 6. Per-workspace enablement

- `Workspace.extensions?: string[]` in `config.ts`, `schemas/config.ts`, and the settings page:
  a section per workspace listing discovered extensions with toggles. Absent = all built-ins.
- Resolution is per request, through `extensionsFor(workspace)` — the settings page's live-apply
  convention holds; there is no restart and no per-workspace instantiation.
- `/api/workspaces` (or `/api/extensions`) returns the resolved list and the wizard steps for the
  chosen workspace, so the page renders what the server says exists and never forms its own
  opinion about enablement. The wizard's `hasJira` prop dies; absent steps are absent.

**Done when:** a workspace configured with `["git", "ci", "github-issues"]` shows no Jira
anywhere — no card, no wizard step, no completion step — and one with nothing configured behaves
as IWE always did.

### 7. Tests, docs, housekeeping

- New tests: resolution rules (absent/explicit/unknown id), the wizard-steps endpoint, the
  github-issues extension against a stubbed `gh`, and the bag on the change record.
- `docs/extensions.md` — the API as an extension author sees it (the surface table, the two-file
  layout, the client registry, what crosses the boundary as JSON). README's requirements and
  configuration sections updated.
- `bun run typecheck && bun run lint && bun test` green; README screenshots unaffected.

## Decisions taken (and revisitable)

1. **Change record**: namespaced `change.extensions[name]` bag for new extensions; `change.jira`
   stays where it is. A generic `change.ticket` would presume one ticket per change, which the
   additive model explicitly does not.
2. **Wizard ordering**: coarse phases rather than a dependency graph — issue-ish steps first, the
   fixed change/repositories steps, then steps that want the repositories (github-issues), with
   the shared draft making prefill order-independent.
3. **Default enablement**: absent `extensions` = all built-ins. The github-issues step therefore
   appears for everyone; it says something useful when no selected repository has a GitHub
   remote, and a workspace that does not want it opts out by naming its extensions.
4. **`/api/jira/issues`** moves under `/api/ext/jira/…` rather than staying as a core route that
   happens to be jira's.
