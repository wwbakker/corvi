/**
 * The included overview contributions, called by name.
 *
 * The contributor shapes are the contract's (`@corvi/contracts/integration`) and re-exported
 * here for the app's one import; the composition — which integration is asked, in what order,
 * gated by workspace enablement — is the app's, because it names the integrations.
 */
import type { Workspace } from "@corvi/configuration/config";
import type {
  DescriptionSection,
  NamedContribution,
  SummaryContributor,
  TitleSource,
} from "@corvi/contracts/integration";
import { extensionEnabled } from "../workspace/server/index.ts";
import { azureDevopsSummaryContributor } from "@corvi/azure-devops";
import { githubSummaryContributor } from "@corvi/github";
import {
  githubIssuesDescriptionSection,
  githubIssuesTitleSource,
} from "@corvi/github/issues";
import { jiraDescriptionSection, jiraTitleSource } from "@corvi/jira";

export type {
  DescriptionSection,
  NamedContribution,
  SummaryContribution,
  SummaryContributor,
  TitleSource,
} from "@corvi/contracts/integration";

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
