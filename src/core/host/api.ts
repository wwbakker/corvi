/**
 * The surface an extension can contribute to.
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
 * This file is the whole API on purpose: out-of-tree extensions get this, and nothing else is a
 * promise. The surface groups live in `api/*.ts` — one file per group, so the contract is
 * navigable — and are re-exported here unchanged.
 */

import type { Effect } from "effect";
import type { Card } from "./api/cards.ts";
import type { CompletionStepContributor, ExtensionEvents } from "./api/lifecycle.ts";
import type {
  DescriptionSection,
  LooseEndContributor,
  SummaryContributor,
  TitleSource,
} from "./api/overview.ts";
import type { Page } from "./api/pages.ts";
import type { RequestMethod, RouteHandler } from "./api/routes.ts";
import type { ExtensionSetting, WorkspaceSetting } from "./api/settings.ts";
import type { TerminalPresenter } from "./api/terminal.ts";
import type { Startup } from "./api/capabilities.ts";
import type { WizardStep } from "./api/wizard.ts";

export { Shell, Workspace, Cache, Settings, Bus } from "./api/capabilities.ts";
export type { Result, Capabilities, Startup } from "./api/capabilities.ts";
export type { Card } from "./api/cards.ts";
export type { WizardStep } from "./api/wizard.ts";
export type {
  PlanWorld,
  CompletionStepContributor,
  ExtensionEvents,
} from "./api/lifecycle.ts";
export type {
  SummaryFact,
  TitleSource,
  SummaryContribution,
  SummaryContributor,
  LooseEndContributor,
  DescriptionSection,
} from "./api/overview.ts";
export type {
  TmuxWindow,
  WindowPresentation,
  TerminalPresenter,
} from "./api/terminal.ts";
export type { Page } from "./api/pages.ts";
export type { ExtensionSetting, WorkspaceSetting } from "./api/settings.ts";
export {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  NotFoundError,
} from "./api/routes.ts";
export type { RouteError, RouteHandler, RequestMethod } from "./api/routes.ts";

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
