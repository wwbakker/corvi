/** The surface an included integration and the application share: what an integration
 * contributes, and the shapes those contributions speak. Ordinary values and Effect types —
 * the host composes the list (`src/integrations/included.ts`); nothing here registers or loads
 * anything.
 */
import type { Effect } from "effect";

import type {
  ChangeWireDto,
  SummaryFactDto,
  WidgetDto,
  WidgetItemDto,
  WidgetStateDto,
} from "./api.ts";
import type { Capabilities } from "./capabilities.ts";
import type { IweError } from "./errors.ts";

// --- Contracts: what a surface is ------------------------------------------------

/** A dashboard card. The card's identity on the routes is the integration's own name, so there
 * is one card per integration; a failure of `status` or `repoStatus` is a red card or a red row
 * carrying the error's message — fail with whatever typed error you like. */
export type Card = {
  title: string;
  /** Which dashboard column the card belongs to: the change's documents on the left, or the
   * status widgets on the right (the default). */
  column?: "left" | "right";
  /** Whole-widget status; a card without it reports per repository. */
  status?: (change: ChangeWireDto) => Effect.Effect<WidgetDto, unknown, Capabilities>;
  /** Rows for one repository, fetched a repository at a time, so a change with many
   * repositories fills in one by one instead of all at the end. */
  repoStatus?: (
    change: ChangeWireDto,
    repo: string,
  ) => Effect.Effect<WidgetItemDto[], unknown, Capabilities>;
  /** Perform an action a row advertised (`arg` is what the row handed back). */
  run?: (
    change: ChangeWireDto,
    action: string,
    arg: string | undefined,
  ) => Effect.Effect<void, unknown, Capabilities>;
};

/** A page the sidebar offers: served at `/<id>`, rendered by the integration's client half
 * exporting `page`. The page exists for a workspace when the integration does. */
export type Page = { id: string; title: string };

/** A tab an integration adds to a change's page, beside the core's Dashboard. The tab exists
 * for a workspace when the integration does, and its client half exports `tab`. */
export type ChangeTab = { id: string; title: string };

/** One step of the "Create change" wizard, as the server declares it. Steps run in phases:
 * `issue` steps come before the change details (they prefill the id and branch), `repos`
 * steps come after the repositories are picked (they need the repositories to look at).
 * Within a phase, registration order. The step's *content* is the integration's client
 * component; this declaration is what the page is told exists. */
export type WizardStep = {
  /** Namespaced by the integration: it doubles as the payload key on the change record. */
  id: string;
  /** What the step's tab in the wizard says. */
  title: string;
  phase: "issue" | "repos";
};

/** One server-wide setting an integration declares: rendered by the settings page in a section
 * per integration, stored under `extensionSettings[name][key]` in the config file. */
export type ExtensionSetting = {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** A list of strings rather than one value, edited as rows. */
  list?: boolean;
  /** A value the page must never receive: the settings view hands over a mask in its place, and
   * the write path keeps what was stored wherever the mask comes back unchanged. An empty value
   * still clears it. The one setting that declares this is the exception to the locking rule: a
   * secret's `env` is a fallback rather than an override, so the page may always edit it (see
   * `src/settings/server/secrets.ts`). */
  secret?: boolean;
  /** The environment variable that overrides this setting, shown locked when set — the page
   * cannot fight it. The override still works through the core config field the integration
   * reads back, and the precedence is: integration setting (page/file) wins, then that config
   * field (which carries defaults + environment resolution), so an env var keeps beating the
   * page. */
  env?: string;
};

/** One per-workspace string field an integration declares: rendered by the settings page and
 * stored under `workspace.extensionSettings[name][key]` — plain data, owned by the
 * integration. */
export type WorkspaceSetting = {
  /** The key under `extensionSettings[name]` this field is stored as. */
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** As on `ExtensionSetting`: the page never receives the value, only a mask, and the mask
   * coming back unchanged means "keep what is stored". */
  secret?: boolean;
};

/** A client-drawn widget an integration adds to a change's dashboard, beside the server-drawn
 * cards. The widget exists for a change when the integration does in the change's workspace,
 * and its client half exports `widget`. */
export type DashboardWidget = {
  /** The widget's identity within its integration, and the key the page knows it by. */
  id: string;
  /** What the widget's heading says, when the component does not draw its own. */
  title: string;
  /** Which dashboard column the widget belongs to: the change's documents on the left, or the
   * status widgets on the right (the default). A document is client state a server card cannot
   * hold — a textarea's debounce and unsaved marker. */
  column?: "left" | "right";
};

/**
 * One included integration, as a value: everything it contributes, described as fields rather
 * than registered anywhere. Arrays are orders: the dashboard's card order, the wizard's step
 * order within a phase, the completion steps' run order. `src/integrations/included.ts` fixes
 * the order across integrations.
 */
export type IncludedIntegration = {
  /** The integration's identity: the key of its entry in a change's `extensions` bag, its
   * cards' identity on the routes, the prefix of its routes. Must be unique. */
  name: string;
  title: string;

  /** Per-workspace settings this integration wants: flat string fields, one per workspace, shown
   * on the settings page for every workspace that has this integration enabled and stored where
   * the integration itself reads them back — `workspace.extensionSettings[name][key]`. */
  workspaceSettings?: WorkspaceSetting[];

  cards?: Card[];
  wizardSteps?: WizardStep[];
  /** Pages this integration offers the sidebar. */
  pages?: Page[];
  /** Tabs this integration adds to a change's page, beside the core's Dashboard. The
   * tab's client half exports `tab`, a component receiving the change. */
  changeTabs?: ChangeTab[];
  /** Client-drawn widgets this integration adds to a change's dashboard, beside the
   * server-drawn cards. The widget's client half exports `widget`, a component receiving
   * the change — for content with client state (a textarea's debounce, an unsaved marker)
   * that a server-drawn card's polled rows cannot hold. */
  dashboardWidgets?: DashboardWidget[];
  /** Server-wide settings this integration declares, shown on the settings page for every
   * workspace — a server-wide thing is configured once, not per context. */
  globalSettings?: ExtensionSetting[];
  routes?: { method: RequestMethod; path: string; handler: RouteHandler }[];
};

// --- Routes ---------------------------------------------------------------------

export type { IweError as RouteError } from "./errors.ts";

/** A route under `/api/ext/<integration>/…`, behind the same origin guard as the core's
 * routes, run as the workspace the request names. Failures map to HTTP status codes through
 * the same mapping the core's routes use — fail with the taxonomy and the status is right.
 *
 * The declared `path` may contain `:name` segments, each capturing one path segment of the
 * request into `params["name"]`. Matching tries the integration's patterns in registration
 * order, then the next integration in load order — the first pattern whose shape fits wins.
 * Handlers that only take `req` stay assignable as they are: a function with fewer parameters
 * is one with more. */
export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Effect.Effect<Response, IweError, Capabilities>;

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// --- Overview: what the integrations add to a change's card -----------------------

/** Names the changes it can title, and answers with summaries. A failed lookup contributes
 * nothing — stored titles stand. Asked once per workspace, with that workspace's claimed
 * changes. */
export type TitleSource = {
  /** Pure: which of these changes are this source's to name. Changes whose title was written
   * by hand are filtered out before this is asked. */
  applies(change: ChangeWireDto): boolean;
  /** Summaries, keyed by change id — not by ticket key, which is the source's own business. */
  lookup(changes: ChangeWireDto[]): Effect.Effect<Map<string, string>, unknown, Capabilities>;
};

/** What one contributor says about a change: facts for the overview card, and — when it has an
 * opinion — the verdict for the change's status icon, which takes the worst of what is offered.
 * A failed contribution contributes nothing. */
export type SummaryContribution = {
  facts: SummaryFactDto[];
  state?: WidgetStateDto;
};

export type SummaryContributor = {
  facts(change: ChangeWireDto): Effect.Effect<SummaryContribution, unknown, Capabilities>;
};

/** A part of the pull-request description. Heading parts are joined with " - " into the first
 * line; a section that has nothing to say returns undefined and is simply absent. */
export type DescriptionSection = {
  heading(change: ChangeWireDto): Effect.Effect<string | undefined, unknown, Capabilities>;
};

/** One contribution paired with the integration it came from: the consumers bind that name into
 * the `ExtensionStore`, so a contributor can write its own files without naming itself. */
export type NamedContribution<T> = { name: string; contribution: T };
