import type { Effect } from "effect";
import type { Change } from "../types.ts";
import type {
  Capabilities,
  Card,
  CompletionStepContributor,
  DescriptionSection,
  Extension,
  ExtensionSetting,
  LooseEndContributor,
  Page,
  RequestMethod,
  RouteHandler,
  SummaryContributor,
  TerminalPresenter,
  TitleSource,
  WizardStep,
  WorkspaceSetting,
} from "./api.ts";

/**
 * The registry: what has been loaded, in load order, and the two operations that put it there —
 * a static description installed as-is, a factory installed once it has run.
 *
 * This is a leaf module. It imports types and nothing that runs, which is what lets
 * `src/terminal.ts` read the window presenters from here without importing the host: the host's
 * module graph reaches back into the terminal through the events, so the registry sits below
 * both and imports neither (docs/guides/style.md, rule 7). It is also why the presenters are
 * aggregated here, next to the `loaded` they read.
 */

/** One extension, as loaded: its description, normalized — the arrays coalesced to empty and
 * the lifecycle handlers pulled out of the events map, so the host's loops stay flat. */
export type LoadedExtension = {
  name: string;
  title: string;
  cards: Card[];
  wizardSteps: WizardStep[];
  titleSources: TitleSource[];
  descriptionSections: DescriptionSection[];
  completionSteps: CompletionStepContributor[];
  /** Handlers declared under `events["change:created"]`, in declaration order. */
  changeCreated: ((change: Change) => Effect.Effect<void, unknown, Capabilities>)[];
  /** The routes, compiled at install: each declared path split on "/", with `:name` segments
   * capturing. Matched in registration order within the extension, load order across them. */
  routes: CompiledRoute[];
  /** What the extension says about changes on their overview cards, in declaration order. */
  summaryContributions: SummaryContributor[];
  /** What cancelling a change would leave behind, per this extension. */
  looseEnds: LooseEndContributor[];
  /** How this extension presents tmux windows — global, see windowPresenters below. */
  windowPresenters: TerminalPresenter[];
  /** Pages this extension offers the sidebar. */
  pages: Page[];
  /** Per-workspace settings the extension declares, for the settings page to render. */
  workspaceSettings: WorkspaceSetting[];
  /** Server-wide settings the extension declares, for the settings page to render. */
  globalSettings: ExtensionSetting[];
  /** Host-internal, out-of-tree extensions only: the sibling client.tsx of the discovered
   * module, which the server builds into a chunk the page imports at runtime
   * (/extensions/<name>/client.js — src/extensions/clientChunks.ts). Built-ins are bundled
   * into the page instead and never carry one. */
  clientPath?: string;
};

/** One route pattern, compiled from its declaration at install: the declared path split on
 * "/". A segment starting with ":" captures one path segment of the request; the others must
 * match exactly. There is no pattern syntax beyond that — routes that need more read the URL
 * themselves. */
export type CompiledRoute = {
  method: RequestMethod;
  segments: string[];
  handler: RouteHandler;
};

export const compileRoutes = (ext: Extension): CompiledRoute[] =>
  (ext.routes ?? []).map((r) => ({
    method: r.method,
    segments: r.path.split("/").filter((segment) => segment !== ""),
    handler: r.handler,
  }));

const normalize = (ext: Extension, clientPath?: string): LoadedExtension => ({
  name: ext.name,
  title: ext.title,
  workspaceSettings: ext.workspaceSettings ?? [],
  globalSettings: ext.globalSettings ?? [],
  cards: ext.cards ?? [],
  wizardSteps: ext.wizardSteps ?? [],
  titleSources: ext.titleSources ?? [],
  descriptionSections: ext.descriptionSections ?? [],
  completionSteps: ext.completionSteps ?? [],
  changeCreated: ext.events?.["change:created"] ?? [],
  routes: compileRoutes(ext),
  summaryContributions: ext.summaryContributions ?? [],
  looseEnds: ext.looseEnds ?? [],
  windowPresenters: ext.windowPresenters ?? [],
  pages: ext.pages ?? [],
  ...(clientPath ? { clientPath } : {}),
});

/** Everything loaded, in load order — which is the dashboard's card order and the wizard's
 * step order within a phase. The test suite prunes and refills this directly. */
export const loaded: LoadedExtension[] = [];

/** Install a static description, rejecting duplicates: a second extension under a used name
 * is skipped with a word, and the original wins. The test suite installs stubs with this. */
export function install(ext: Extension, clientPath?: string): LoadedExtension {
  if (!ext.name) {
    console.error(`an extension without a name is skipped`);
    return normalize({ ...ext, name: "" }, clientPath);
  }
  const clash = loaded.find((e) => e.name === ext.name);
  if (clash) {
    console.error(`two extensions are called "${ext.name}" — the second one is skipped`);
    return clash;
  }
  const record = normalize(ext, clientPath);
  loaded.push(record);
  return record;
}

/** Every loaded extension's window presenters, in load order.
 *
 * Deliberately **global, not per-workspace**: presenters are pure functions of tmux data,
 * they run no effects and take no capabilities, and a window's name cannot depend on whose
 * client happens to be looking. Enablement stays for the surfaces that do things.
 *
 * The aggregation lives here, over the `loaded` array above, rather than in the host — see the
 * module comment for why (src/terminal.ts must read it without importing the host). */
export const windowPresenters = (): TerminalPresenter[] => loaded.flatMap((e) => e.windowPresenters);
