import { Context, Effect } from "effect";
import type { CliError } from "../effect/errors.ts";
import type {
  Change,
  CompletionStep,
  SummaryFact,
  Widget,
  WidgetItem,
  WidgetState,
} from "../types.ts";
import type { Config, Workspace as WorkspaceConfig } from "../config.ts";
import { Workspace as WorkspaceTag } from "../effect/tags.ts";

/**
 * The surface an extension can contribute to — Effect edition.
 *
 * An extension is a TypeScript module with a default-exported factory receiving this API — the
 * same shape pi's extensions have. It contributes to registries (cards, wizard steps, hooks)
 * and the host wires it up; it never mutates host state directly, and nothing here is named
 * after a vendor: an extension hooks the "Create change" screen, not "the task board".
 *
 * Everything is additive: any number of extensions may contribute to any surface, and the
 * per-workspace enablement (the `extensions` list in the workspace config) decides whose
 * contributions exist for the request in hand. There are no singleton slots to arbitrate.
 *
 * Handlers are Effects, and that is the dependency-injection contract:
 *
 * - **The host provides `Capabilities`** — the Workspace tag (the request's own), a `Shell`
 *   for subprocesses with the workspace's environment, the answer `Cache`, the `Settings`,
 *   and the event `Bus`. An effect may require any subset; requiring anything outside the
 *   union fails to typecheck, which is what makes "no host imports" checkable rather than a
 *   matter of discipline.
 * - **Failures are values in the E channel.** On the capability surfaces the host handles any
 *   failure by its message (a failed card is a red card, a failed lookup contributes
 *   nothing), so those channels are `unknown` — fail with whatever typed error you like.
 *   Routes are the exception: their failures map to HTTP status codes, so they are typed as
 *   the taxonomy (`RouteError`), exactly like the core's own routes.
 * - **Pure functions stay pure.** `applies` and `plan` are synchronous and receive plain
 *   data; no effect wrapper buys anything there, and the completion plan must be answerable
 *   before anything runs anyway.
 *
 * This file is the whole API on purpose: when out-of-tree extensions arrive, this is what
 * they get, and nothing else is a promise.
 */

// --- Capabilities: what the host provides to every contributed effect ---------------------

/** The request's workspace — the same tag the core's routes provide (src/effect/tags.ts).
 * Re-exported so this file stays the one import an extension needs. */
export { WorkspaceTag as Workspace };

/** One CLI call's outcome: exit codes are data — callers branch on `code`; the typed failure
 * is reserved for a timeout, which kills the child (src/sh.ts). */
export type { Result } from "../sh.ts";

/** One fact on a change's overview card. Defined in types.ts with the dashboard's vocabulary
 * (the summary surface speaks it too); re-exported so this file stays the one import an
 * extension needs. */
export type { SummaryFact };

/** Run a subprocess with the request workspace's environment already applied
 * (`GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_API_TOKEN`, …), through the shared semaphore
 * and the CLI timeout. `run` requires `Workspace` because the environment comes from it:
 * the host provides the tag alongside the service, so requiring both is free. */
export class Shell extends Context.Tag("iwe/Shell")<Shell, {
  run(cmd: readonly string[], opts?: { cwd?: string }): Effect.Effect<
    { code: number; stdout: string; stderr: string },
    CliError,
    WorkspaceTag
  >;
}>() {}

/** The answer cache: read-through with a TTL, one shared refresh per key, and prefix
 * invalidation for when an action has just made an answer wrong. The work's requirements
 * pass through untouched — the cache stores outcomes, not contexts. */
export class Cache extends Context.Tag("iwe/Cache")<Cache, {
  swr<A, E, R>(key: string, ttlMs: number, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  invalidate(prefix: string): Effect.Effect<void>;
}>() {}

/** The settings in effect — the same refilled object every module holds, so a settings-page
 * save is visible without restart. Read-only by convention. */
export class Settings extends Context.Tag("iwe/Settings")<Settings, Config>() {}

/** Say something changed, so open pages refetch through the event stream. */
export class Bus extends Context.Tag("iwe/Bus")<Bus, {
  announce(event: "changes" | "windows"): Effect.Effect<void>;
}>() {}

/** The union the host provides. An effect may require any subset — requiring less is
 * assignable to requiring the union, so handlers declare only what they use. */
export type Capabilities = WorkspaceTag | Shell | Cache | Settings | Bus;

/** What an extension's *load* may require: everything but the request `Workspace`, which does
 * not exist at startup. The loader provides the default workspace alongside the services, so
 * load-time `Shell` runs with its environment. */
export type Startup = Shell | Cache | Settings | Bus;

// --- Routes get the real prize of typed errors: the host maps them to status codes --------

export {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  NotFoundError,
} from "../effect/errors.ts";
export type RouteError = import("../effect/errors.ts").IweError;

// --- Surfaces -----------------------------------------------------------------------------

/** A dashboard card. The card's identity on the routes is the extension's own name, so there
 * is one card per extension; a failure of `status` or `repoStatus` is a red card or a red row
 * carrying the error's message — fail with whatever typed error you like. */
export type Card = {
  title: string;
  /** Ask for the tall column of its own on a wide window (the CI card's tree). */
  wide?: boolean;
  /** Whole-widget status; a card without it reports per repository. */
  status?: (change: Change) => Effect.Effect<Widget, unknown, Capabilities>;
  /** Rows for one repository, fetched a repository at a time, so a change with many
   * repositories fills in one by one instead of all at the end. */
  repoStatus?: (change: Change, repo: string) => Effect.Effect<WidgetItem[], unknown, Capabilities>;
  /** Perform an action a row advertised (`arg` is what the row handed back). */
  run?: (
    change: Change,
    action: string,
    arg: string | undefined,
  ) => Effect.Effect<void, unknown, Capabilities>;
};

/** One step of the "Create change" wizard, as the server declares it. Steps run in phases:
 * `issue` steps come before the change details (they prefill the id and branch), `repos`
 * steps come after the repositories are picked (they need the repositories to look at).
 * Within a phase, registration order. The step's *content* is the extension's client
 * component; this declaration is what the page is told exists. */
export type WizardStep = {
  /** Namespaced by the extension: it doubles as the payload key on the change record. */
  id: string;
  /** What the step's tab in the wizard says. */
  title: string;
  phase: "issue" | "repos";
};

/** Names the changes it can title, and answers with summaries. A failed lookup contributes
 * nothing — stored titles stand, which is the behaviour the overview has always had. Asked
 * once per workspace, with that workspace's claimed changes. */
export type TitleSource = {
  /** Pure: which of these changes are this source's to name. Changes whose title was
   * written by hand are filtered out before this is asked. */
  applies(change: Change): boolean;
  /** Summaries, keyed by change id — not by ticket key, which is the source's own business. */
  lookup(changes: Change[]): Effect.Effect<Map<string, string>, unknown, Capabilities>;
};

/** What one contributor says about a change: facts for the overview card, and — when it has
 * an opinion — the verdict for the change's status icon in the navigation, which takes the
 * worst of what is offered. A failed contribution contributes nothing. */
export type SummaryContribution = {
  facts: SummaryFact[];
  state?: WidgetState;
};

export type SummaryContributor = {
  facts(change: Change): Effect.Effect<SummaryContribution, unknown, Capabilities>;
};

/** What cancelling this change would leave behind, said so you can act on it: the open
 * ticket, the open pull requests. One string per end, phrased for a person. A failed
 * contribution contributes nothing. */
export type LooseEndContributor = {
  looseEnds(change: Change): Effect.Effect<string[], unknown, Capabilities>;
};

/** The raw facts tmux reports about one window, before anyone says what to call it. */
export type TmuxWindow = {
  index: number;
  name: string;
  /** What is running in the active pane: zsh, nvim, gradle, ... */
  command: string;
  active: boolean;
  /** Output arrived since you last looked at it. */
  activity: boolean;
  /** Directory of the active pane: which repository the window is in, which is usually what
   * you want to know about it. */
  directory: string;
  /** Whether the name is one you gave it. tmux renames a window after whatever runs in it
   * until you name it yourself, which switches automatic renaming off. */
  named: boolean;
  /** The pane options any presenter declared, by option name ("@agent" → "working"). */
  options: Record<string, string>;
  /** tmux's own window id (`@3`): stable across reordering, unlike the index the session shows
   * and the tabs move around. */
  id: string;
};

/** How a window is presented. The first presenter that answers a field wins; fields left out
 * come from the next presenter, and the core's defaults last. The label is composed by the
 * core (from `running`), so a presenter that only says what is running still gets a good
 * name. */
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
  /** Whether this window wants the user now — what notifications are made of. The core only
   * sees the edge into it; the presenter owns what it means and when it clears. */
  attention?: boolean;
  /** A line of the presenter's own words to carry beside the name: an agent can say what it
   * just answered, instead of only that it stopped. */
  note?: string;
};

/** Says how a tmux window is presented: which pane options to read for it, and what those
 * options mean. Pure — plain tmux data in, plain data out — so it runs wherever the windows
 * are listed, with no workspace and no services in sight. */
export type TerminalPresenter = {
  /** Pane options to read for every window of every session, e.g. ["@agent"]. */
  paneOptions?: string[];
  /** Nothing to say about this window is `undefined` — it simply falls through. */
  present(window: TmuxWindow): WindowPresentation | undefined;
};

/** A page the sidebar offers: served at `/<id>`, rendered by the extension's client half
 * exporting `page`. The page exists for a workspace when the extension does. */
export type Page = { id: string; title: string };

/** One server-wide setting an extension declares: rendered by the settings page in a section
 * per extension, stored under `extensionSettings[name][key]` in the config file. */
export type ExtensionSetting = {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** A list of strings rather than one value, edited as rows. */
  list?: boolean;
  /** The environment variable that overrides this setting, shown locked when set — the page
   * cannot fight it. The override itself still works through the legacy config field the
   * extension reads back, and the precedence is: extension setting (page/file) wins, then the
   * legacy field (which carries defaults + environment resolution), so an env var keeps beating
   * the page exactly as it beats the file today. */
  env?: string;
};

/** A part of the pull-request description. Heading parts are joined with " - " into the
 * first line; a section that has nothing to say returns undefined and is simply absent. */
export type DescriptionSection = {
  heading(change: Change): Effect.Effect<string | undefined, unknown, Capabilities>;
};

/** What a pure completion-plan function is handed, since it runs before anything does: the
 * plain data it may name a step from. Pure functions get plain data, not services. */
export type PlanWorld = { config: Config; workspace: WorkspaceConfig };

/** One step of completing a change, contributed alongside the core's own (merge the pull
 * requests, remove the worktrees, archive). Contributed steps run after the merges and
 * before the worktrees go, in registration order, and are journaled like every other step:
 * the plan is named before anything runs, and the outcome is written as it happens. */
export type CompletionStepContributor = {
  /** The step as the plan shows it while waiting, or undefined when this change has nothing
   * for it to do (no issue linked, say) — in which case `run` is not called either. */
  plan(change: Change, world: PlanWorld): CompletionStep | undefined;
  /** Do it. A returned string is recorded as the step's detail; a failure stops the
   * completion where it stands, exactly as a core step's failure does. */
  run(change: Change): Effect.Effect<string | void, unknown, Capabilities>;
};

/** A route under `/api/ext/<extension>/…`, behind the same origin guard as the core's
 * routes, run as the workspace the request names. Failures map to HTTP status codes through
 * the same mapping the core's routes use — fail with the taxonomy and the status is right.
 *
 * The declared `path` may contain `:name` segments, each capturing one path segment of the
 * request into `params["name"]`. Matching tries the extension's patterns in registration
 * order, then the next extension in load order — the first pattern whose shape fits wins.
 * Handlers that only take `req` stay assignable as they are: a function with fewer parameters
 * is one with more. */
export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Effect.Effect<Response, RouteError, Capabilities>;

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The handlers an extension can hang off the change lifecycle. Grows per event, typed, when a
 * second consumer needs one. */
export type ExtensionEvents = {
  "change:created"?: ((change: Change) => Effect.Effect<void, unknown, Capabilities>)[];
};

/**
 * An extension, as a value: everything it contributes, described rather than registered.
 *
 * Most extensions are static — a plain object literal, no Effect ceremony. One that needs to
 * compute its contributions at startup (check a CLI exists, read a file, decide conditionally)
 * exports a factory returning this shape from an Effect instead; the loader accepts both.
 *
 * Arrays are orders: the dashboard's card order, the wizard's step order within a phase, the
 * completion steps' run order. Across extensions, the loader's own order decides.
 */

/** One per-workspace string field an extension declares: rendered by the settings page and
 * stored under `workspace.extensionSettings[name][key]` — plain data, owned by the extension. */
export type WorkspaceSetting = {
  /** The key under `extensionSettings[name]` this field is stored as. */
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
};

export type Extension = {
  /** The extension's identity: the key of its entry in a change's `extensions` bag, its
   * cards' identity on the routes, the prefix of its routes. Must be unique. */
  name: string;
  title: string;

  /** Per-workspace settings this extension wants: flat string fields, one per workspace, shown
   * on the settings page for every workspace that has this extension enabled and stored where
   * the extension itself reads them back — `workspace.extensionSettings[name][key]`. */
  workspaceSettings?: WorkspaceSetting[];

  cards?: Card[];
  wizardSteps?: WizardStep[];
  titleSources?: TitleSource[];
  descriptionSections?: DescriptionSection[];
  completionSteps?: CompletionStepContributor[];
  /** Facts about a change, said on its overview card; the host merges every contributor's
   * answer into the one summary the card renders. */
  summaryContributions?: SummaryContributor[];
  /** What cancelling a change would leave behind; the host asks every contributor. */
  looseEnds?: LooseEndContributor[];
  /** How tmux windows are named and drawn. Presenters are global, not per-workspace: they
   * are pure functions of tmux data, and a window's name cannot depend on whose client
   * happens to be looking. */
  windowPresenters?: TerminalPresenter[];
  /** Pages this extension offers the sidebar. */
  pages?: Page[];
  /** Server-wide settings this extension declares, shown on the settings page for every
   * workspace — a server-wide thing is configured once, not per context. */
  globalSettings?: ExtensionSetting[];
  events?: ExtensionEvents;
  routes?: { method: RequestMethod; path: string; handler: RouteHandler }[];
};

/** Run once at startup, before any request, and produce the description. A failed load is an
 * extension absent, with the error logged — a broken optional plugin does not take the
 * dashboard down. */
export type ExtensionFactory = () => Effect.Effect<Extension, unknown, Startup>;

/** What an extension module default-exports: a static value, or a factory for one. */
export type ExtensionModule = Extension | ExtensionFactory;
