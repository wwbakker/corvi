/**
 * The included overview contributions, called by name.
 *
 * These were extension-contract fields until the platform started coming apart; now the app
 * composes the included integrations explicitly, gated by workspace enablement and in the load
 * order the selectors used. The contributor shapes live here so the modules and their consumers
 * share one definition without going through the host contract.
 */
import type { Effect } from "effect";
import type { Change } from "../domain/change.ts";
import type { Workspace } from "../domain/config.ts";
import type { SummaryFact, WidgetState } from "../domain/widget.ts";
import type { Capabilities } from "../extension-host/api/capabilities.ts";
import { extensionEnabled } from "../workspace/server/index.ts";
import { azureDevopsSummaryContributor } from "../extensions/azure-devops/index.ts";
import { githubSummaryContributor } from "../extensions/github/index.ts";
import {
  githubIssuesDescriptionSection,
  githubIssuesTitleSource,
} from "../extensions/github-issues/index.ts";
import { jiraDescriptionSection, jiraTitleSource } from "../extensions/jira/index.ts";

/** Names the changes it can title, and answers with summaries. A failed lookup contributes
 * nothing — stored titles stand. Asked once per workspace, with that workspace's claimed
 * changes. */
export type TitleSource = {
  /** Pure: which of these changes are this source's to name. Changes whose title was written
   * by hand are filtered out before this is asked. */
  applies(change: Change): boolean;
  /** Summaries, keyed by change id — not by ticket key, which is the source's own business. */
  lookup(changes: Change[]): Effect.Effect<Map<string, string>, unknown, Capabilities>;
};

/** What one contributor says about a change: facts for the overview card, and — when it has an
 * opinion — the verdict for the change's status icon, which takes the worst of what is offered.
 * A failed contribution contributes nothing. */
export type SummaryContribution = {
  facts: SummaryFact[];
  state?: WidgetState;
};

export type SummaryContributor = {
  facts(change: Change): Effect.Effect<SummaryContribution, unknown, Capabilities>;
};

/** A part of the pull-request description. Heading parts are joined with " - " into the first
 * line; a section that has nothing to say returns undefined and is simply absent. */
export type DescriptionSection = {
  heading(change: Change): Effect.Effect<string | undefined, unknown, Capabilities>;
};

/** One contribution paired with the integration it came from: the consumers bind that name into
 * the `ExtensionStore`, so a contributor can write its own files without naming itself. */
export type NamedContribution<T> = { name: string; contribution: T };

/** The title sources a workspace's changes are named by, in load order (jira before
 * github-issues). Disabled integrations are not asked. */
export const includedTitleSources = (workspace: Workspace): NamedContribution<TitleSource>[] => [
  ...(extensionEnabled(workspace, "jira")
    ? [{ name: "jira", contribution: jiraTitleSource }]
    : []),
  ...(extensionEnabled(workspace, "github-issues")
    ? [{ name: "github-issues", contribution: githubIssuesTitleSource }]
    : []),
];

/** The pull-request description sections a change's heading is made of, in the same order. */
export const includedDescriptionSections = (
  workspace: Workspace,
): NamedContribution<DescriptionSection>[] => [
  ...(extensionEnabled(workspace, "jira")
    ? [{ name: "jira", contribution: jiraDescriptionSection }]
    : []),
  ...(extensionEnabled(workspace, "github-issues")
    ? [{ name: "github-issues", contribution: githubIssuesDescriptionSection }]
    : []),
];

/** The overview contributions a change's card gathers, in load order (github before
 * azure-devops). */
export const includedSummaryContributors = (
  workspace: Workspace,
): NamedContribution<SummaryContributor>[] => [
  ...(extensionEnabled(workspace, "github")
    ? [{ name: "github", contribution: githubSummaryContributor }]
    : []),
  ...(extensionEnabled(workspace, "azure-devops")
    ? [{ name: "azure-devops", contribution: azureDevopsSummaryContributor }]
    : []),
];
