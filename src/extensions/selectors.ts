import type { Change } from "../types.ts";
import type { Workspace } from "../config.ts";
import { workspaceOf } from "../workspaces.ts";
import { loaded, type LoadedExtension } from "./registry.ts";
import type {
  Card,
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
 * A workspace that names none has all of them — which is what IWE was before extensions
 * existed, and what an unconfigured machine still gets. The legacy vendor flags (`jira: false`,
 * `azure: false`) are gone: migrateWorkspaceSettings turns them into an explicit extensions
 * list on load, so there is nothing left to special-case here.
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

/** The cards a change's dashboard shows, with the extension each belongs to — the extension's
 * name is the card's identity on the routes. */
export const cardsFor = (change: Change): { name: string; card: Card }[] =>
  contributed(workspaceOf(change), (e) => e.cards.map((card) => ({ name: e.name, card })));

/** One card by the extension's name, across every loaded extension. A change's workspace
 * governs which cards are *listed*; a card addressed directly is looked up everywhere, as it
 * always was. */
export const cardByName = (name: string): Card | undefined =>
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

export const titleSourcesFor = (workspace: Workspace): TitleSource[] =>
  contributed(workspace, (e) => e.titleSources);

export const descriptionSectionsFor = (workspace: Workspace): DescriptionSection[] =>
  contributed(workspace, (e) => e.descriptionSections);

export const completionStepsFor = (workspace: Workspace): CompletionStepContributor[] =>
  contributed(workspace, (e) => e.completionSteps);

export const summaryContributorsFor = (workspace: Workspace): SummaryContributor[] =>
  contributed(workspace, (e) => e.summaryContributions);

export const looseEndContributorsFor = (workspace: Workspace): LooseEndContributor[] =>
  contributed(workspace, (e) => e.looseEnds);

/** The pages a workspace's sidebar offers, with the extension each belongs to — the page's
 * identity on the routes and the URL is the extension's own. */
export type PageInfo = Page & { extension: string };

export const pagesFor = (workspace: Workspace): PageInfo[] =>
  contributed(workspace, (e) => e.pages.map((page) => ({ ...page, extension: e.name })));
