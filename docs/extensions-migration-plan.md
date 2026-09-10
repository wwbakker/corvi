# Extensions: the second migration slice

> **Status: in progress.** This plan covers what is still hardcoded in the core after the
> task-board slice (docs/extensions-plan.md, implemented) and the Effect rewrite
> (docs/effect-conventions.md, implemented), and how it moves behind the extension API
> (src/extensions/api.ts).

## What is still hardcoded, and what happens to it

| Hardcoded today | Where | Becomes |
|---|---|---|
| The overview's per-change summary (pipelines active, unresolved comments, CI verdict) | `src/summary.ts`, `src/web/ChangeCard.tsx`, `src/web/Sidebar.tsx` (Icons) | `summaryContributions` surface — the ci extension contributes the vendor facts; the core contributes the terminals fact (tmux stays core) |
| What cancelling leaves behind (the open ticket, the open pull requests) | `src/cancel.ts` (`looseEndsEffect`) | `looseEnds` surface — jira contributes the ticket, ci contributes the pull requests |
| How terminal windows are named, which icon they draw, what counts as "busy", the agent state | `src/web/windowLabel.ts`, `src/windows.ts` (`busyWindows`), the `@agent` parsing in `src/terminal.ts`, `src/web/Sidebar.tsx` | `windowPresenters` surface — a new `agents` extension reads `@agent`; the core composes the default label; the page renders what the server sends |
| The deployments page (Azure DevOps) and its routes | `src/deployments.ts` (implementation stays), `src/web/DeploymentsPage.tsx`, `DeployDialog.tsx`, the `/api/deployments*` routes, the Sidebar's hardcoded Deployments entry, `hasDeployments` in `app.tsx` | a `pages` surface + the deployments extension (routes under `/api/ext/deployments/…`, page in its client half); `workspace.azure: false` folds into per-workspace enablement |
| Vendor-named fields on the settings page (Jira transitions, Azure organisation, deploy conventions) | `src/web/SettingsPage.tsx`, `src/config.ts` | `globalSettings` surface — extensions declare server-wide settings, stored under `extensionSettings[name][key]`, rendered generically; the legacy config fields stay as fallback reads |

Not migrated, on purpose:

- **tmux and ttyd themselves** (`src/terminal.ts` session handling, `src/terminalProxy.ts`) —
  the terminal is the core's own furniture. What surrounds it (names, icons, status) is the
  extensible part.
- **The per-workspace `azure` object** (organisation/project overrides) — still read by the
  deployments implementation via the `Workspace` tag; it is that extension's own business now.
- **`src/integrations/*`** — shared libraries; built-in extensions import them, as the git
  extension always has. The "no host imports" rule is about the capability contract, not
  about which files a built-in may read.

## API additions (src/extensions/api.ts)

All additive; every surface follows the file's existing rules — additive arrays, Effects with
the `Capabilities` union for anything that runs, pure functions for anything that only decides.

```ts
/** One fact on a change's overview card: a coloured dot and a phrase. */
export type SummaryFact = {
  id: string;            // stable key, e.g. "pipelines"
  label: string;         // rendered as-is: "2 pipelines active", "terminals idle"
  state?: WidgetState;   // colours the dot; "none" is the idle grey
};

/** What one contributor says about a change. `state`, when given, is its verdict for the
 * change's status icon in the navigation — the icon takes the worst of what is offered. */
export type SummaryContribution = { facts: SummaryFact[]; state?: WidgetState };

export type SummaryContributor = {
  facts(change: Change): Effect.Effect<SummaryContribution, unknown, Capabilities>;
};
// Extension: summaryContributions?: SummaryContributor[]

export type LooseEndContributor = {
  /** What cancelling this change would leave behind, said so you can act on it. */
  looseEnds(change: Change): Effect.Effect<string[], unknown, Capabilities>;
};
// Extension: looseEnds?: LooseEndContributor[]

/** The raw facts tmux reports about one window, before anyone says what to call it. */
export type TmuxWindow = {
  index: number;
  name: string;
  command: string;
  active: boolean;
  activity: boolean;
  directory: string;
  named: boolean;
  /** The pane options any presenter declared, by option name ("@agent" → "working"). */
  options: Record<string, string>;
};

/** How a window is presented. The first presenter that answers a field wins; fields left out
 * come from the next presenter, and the core's defaults last. The label is composed by the
 * core (below), so a presenter that only says what is running still gets a good name. */
export type WindowPresentation = {
  /** Override the composed name entirely. */
  label?: string;
  /** What is running in it, said the way a person would: "pi working", "nvim". */
  running?: string;
  /** One line about what is happening, for a tooltip or a status bar. */
  detail?: string;
  /** Which icon to draw — a name the page knows ("terminal", "agent"); unknown names fall
   * back to the terminal glyph. */
  icon?: string;
  /** The icon's colour: "ok" when it is working, "idle" at a prompt. */
  state?: "ok" | "idle";
  /** Whether this counts as work happening (the overview's terminals fact). */
  busy?: boolean;
};

export type TerminalPresenter = {
  /** Pane options to read for every window of every session, e.g. ["@agent"]. */
  paneOptions?: string[];
  /** Pure: plain tmux data in, plain data out. */
  present(window: TmuxWindow): WindowPresentation | undefined;
};
// Extension: windowPresenters?: TerminalPresenter[]
```

Presenters are **global, not per-workspace**: they are pure functions of tmux data, run no
effects, and a window's name cannot depend on whose client happens to be looking. Enablement
stays for the surfaces that do things.

```ts
/** A page the sidebar offers: served at /<id>, rendered by the extension's client half
 * exporting `page`. The page exists for a workspace when the extension does. */
export type Page = { id: string; title: string };
// Extension: pages?: Page[]

/** One server-wide setting an extension declares: rendered by the settings page in a section
 * per extension, stored under `extensionSettings[name][key]` in the config file. */
export type ExtensionSetting = {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** A list of strings rather than one value, edited as rows. */
  list?: boolean;
  /** The environment variable that overrides this setting, shown locked when set. The
   * override itself still works through the legacy config field the extension reads back. */
  env?: string;
};
// Extension: globalSettings?: ExtensionSetting[]
```

Routes gain **path parameters** — the deployments routes need them, and every future
extension will:

```ts
export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Effect.Effect<Response, RouteError, Capabilities>;

// path: "/services/:service/versions" — ":name" captures one segment.
```

First matching pattern wins (registration order, then load order). Existing handlers, which
take only `req`, remain assignable — a function with fewer parameters is one with more.

## The wire shapes

- `GET /api/changes/:id/summary` → `{ facts: SummaryFact[], state: WidgetState }` (was
  `{ pipelines, unresolved, terminals, windows, ci }`). The core's terminals fact and the ci
  extension's contribution are merged by the host; `state` is the worst offered verdict and
  drives the navigation's CI icon.
- Terminal windows (GET `/api/terminals`, the terminal windows routes) carry the **presented**
  shape, not the raw one: `{ index, label, detail, icon?, state?, active, activity }`. The
  `agent` field and the page-side `windowLabel()` composition die — the server says what a
  window is called.
- `GET /api/pages?workspace=…` → `{ pages: [{ id, title, extension }] }` — the sidebar offers
  what the server says exists, exactly as the wizard already does with steps.
- The deployments routes move under `/api/ext/deployments/…` (`/services`,
  `/services/:service/versions`, `POST /services/:service/deploy`); the page URL stays
  `/deployments`.
- Extension settings cross as data: `SettingsView.extensions` entries gain `globalSettings`,
  and `extensionSettings[name][key]` in the config file holds strings or string lists.

## Behaviour preservation

Every user-visible string, status code, ordering and fallback is preserved. The label
composition, the busy heuristic (shells idle, an agent believed over its process name), the
worst-of icon rule, the promotion guard on deploys, the loose-end wording, the settings-page
locking and empty-means-unset pruning — all kept, only relocated. Legacy config keys
(`change.jira`, `jira: false`, `azure: false`, `jiraAssignee`, `azureDeploy.*`) stay readable
as fallbacks and fold into the modern shape on load, as the task-board slice did.

Three orderings changed on purpose, and the change is accepted rather than papered over. The
summary card now reads the core's own terminals fact first, with the extension facts after it
in load order — the core leads, the contributors follow. Cancelling's loose ends likewise
follow extension load order, so the pull requests now come before the ticket; the set of
sentences is unchanged. And the terminal icon's tooltip is the window's whole composed label
rather than the bare process name. A thinner settings page rides along with the slice: the
extension-declared settings sections show the declared placeholder rather than the computed
effective value — the page stays thin, and the declared placeholder carries the default in
words.

**Known baseline:** `bun run test` has exactly one failing test, the WebKit smoke test, which
cannot launch on this machine (missing system libraries — environmental, pre-existing).
Every slice ends with `bunx tsc --noEmit`, `bun run lint` and `bun run test` at that same
baseline and nothing new. Tests are updated where the surface legitimately changed — same
intent, new seam — which is the rule the task-board slice used.

## The work packages

1. **API + terminal presentation** — api.ts surfaces, host registries, the presenter merge in
   `terminal.ts`, the `agents` extension, `windows.ts` and `windowLabel.ts` retired, the page
   rendering presented windows, `worst()` moved to types.ts.
2. **Summary facts** — `ChangeSummary` becomes `{ facts, state }`; the ci extension
   contributes pipelines/unresolved/verdict; the core contributes the terminals fact;
   ChangeCard and the sidebar render facts.
3. **Loose ends** — cancelling asks the contributors; jira and ci answer.
4. **Pages + deployments** — the pages surface, `/api/pages`, the PageHost and registry in the
   page, route parameters, the deployments extension (routes + client half); `hasDeployments`
   dies; `azure: false` folds into enablement.
5. **Global settings** — the settings surface, the config bag, generic extension sections on
   the settings page; jira and deployments declare their fields with legacy fallback reads.
6. **Docs** — docs/extensions.md and the README brought to the new reality.
7. **Review** — a fresh reviewer walks the whole diff against the plan and the conventions;
   findings are fixed before the slice lands.
