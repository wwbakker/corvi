import type { Change } from "../domain/change.ts";
import type { Workspace } from "../domain/config.ts";
import { workspaceOf } from "../../workspace/server/index.ts";
import { loaded, type LoadedExtension } from "./registry.ts";
import type {
  Card,
  ChangeTab,
  CompletionStepContributor,
  DescriptionSection,
  LooseEndContributor,
  Page,
  SummaryContributor,
  TitleSource,
  WizardStep,
} from "./api.ts";

/**
 * The workspace queries: which extensions exist for a workspace, and one flat list per surface
 * they contribute to. Every selector below is the same shape — take the workspace's extensions,
 * concatenate each one's slice — so that shape lives once, in `contributed`, rather than as a
 * clone per surface (docs/guides/style.md, rule 6). The output order is load order, which is
 * also each surface's presentation order.
 */

/**
 * Which extensions exist for this workspace.
 *
 * A workspace that names none has all of them, which is what an unconfigured machine gets.
 * Enablement is the extensions list alone.
 */
export const extensionsFor = (workspace: Workspace): LoadedExtension[] => {
  const names = workspace.extensions;
  if (!names) return loaded;
  const wanted = new Set(names);
  return loaded.filter((e) => wanted.has(e.name));
};

/** One surface across a workspace's extensions, concatenated in load order. */
const contributed = <T>(
  workspace: Workspace,
  pick: (ext: LoadedExtension) => readonly T[],
): T[] => extensionsFor(workspace).flatMap(pick);

/** One contribution paired with the extension it came from. The host binds that name into the
 * `ExtensionStore` when it runs the effect, so a hook or a step can write its own files without
 * naming itself. */
export type NamedContribution<T> = { name: string; contribution: T };

/** One surface across a workspace's extensions, each contribution named for its extension, in
 * load order. */
const namedContributed = <T>(
  workspace: Workspace,
  pick: (ext: LoadedExtension) => readonly T[],
): NamedContribution<T>[] =>
  extensionsFor(workspace).flatMap((e) => pick(e).map((contribution) => ({ name: e.name, contribution })));

/** The cards a change's dashboard shows, with the extension each belongs to — the extension's
 * name is the card's identity on the routes. */
export const cardsFor = (change: Change): { name: string; card: Card }[] =>
  contributed(workspaceOf(change), (e) => e.cards.map((card) => ({ name: e.name, card })));

/** One card by the extension's name, across every loaded extension. A change's workspace
 * governs which cards are *listed*; a card addressed directly is looked up everywhere. */
export const cardForExtension = (name: string): Card | undefined =>
  loaded.find((e) => e.name === name)?.cards[0];

/** The wizard steps of a workspace, in presentation order: issue steps before the change
 * details, repository-aware steps after the repositories are picked. */
export type WizardStepInfo = WizardStep & { extension: string };

export const wizardStepsFor = (workspace: Workspace): WizardStepInfo[] => {
  const steps = contributed(workspace, (e) =>
    e.wizardSteps.map((s) => ({ ...s, extension: e.name })),
  );
  return [...steps.filter((s) => s.phase === "issue"), ...steps.filter((s) => s.phase === "repos")];
};

export const titleSourcesFor = (workspace: Workspace): NamedContribution<TitleSource>[] =>
  namedContributed(workspace, (e) => e.titleSources);

export const descriptionSectionsFor = (
  workspace: Workspace,
): NamedContribution<DescriptionSection>[] =>
  namedContributed(workspace, (e) => e.descriptionSections);

export const completionStepsFor = (
  workspace: Workspace,
): NamedContribution<CompletionStepContributor>[] =>
  namedContributed(workspace, (e) => e.completionSteps);

export const summaryContributorsFor = (
  workspace: Workspace,
): NamedContribution<SummaryContributor>[] =>
  namedContributed(workspace, (e) => e.summaryContributions);

export const looseEndContributorsFor = (
  workspace: Workspace,
): NamedContribution<LooseEndContributor>[] =>
  namedContributed(workspace, (e) => e.looseEnds);

/** The pages a workspace's sidebar offers, with the extension each belongs to — the page's
 * identity on the routes and the URL is the extension's own. */
export type PageInfo = Page & { extension: string };

export const pagesFor = (workspace: Workspace): PageInfo[] =>
  contributed(workspace, (e) => e.pages.map((page) => ({ ...page, extension: e.name })));

/** A change tab across a workspace's extensions, with the extension each belongs to — the
 * tab's identity on the routes and the change URL. */
export type ChangeTabInfo = ChangeTab & { extension: string };

/** The tabs a workspace's extensions add to a change's page, in load order. A tab id is the
 * tab's identity on the route and the URL, so a duplicate would be two tabs at one address:
 * the first extension to declare an id keeps it and a later one's is skipped, mirroring how a
 * duplicate extension name is resolved (registry.install). */
export const changeTabsFor = (workspace: Workspace): ChangeTabInfo[] => {
  const seen = new Set<string>();
  const tabs: ChangeTabInfo[] = [];
  for (const tab of contributed(workspace, (e) =>
    e.changeTabs.map((t) => ({ ...t, extension: e.name })),
  )) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  return tabs;
};
