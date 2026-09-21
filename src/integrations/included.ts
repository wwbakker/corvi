import type { IncludedIntegration } from "./types.ts";
import agents from "../extensions/agents/index.ts";
import git from "../extensions/git/index.ts";
import github from "../extensions/github/index.ts";
import jira from "../extensions/jira/index.ts";
import githubIssues from "../extensions/github-issues/index.ts";
import azureDevops from "../extensions/azure-devops/index.ts";
import leftovers from "../extensions/leftovers/index.ts";
import review from "../extensions/review/index.ts";
import notes from "../extensions/notes/index.ts";

/**
 * The integrations that ship with Corvi, in order: the agents' furniture first (it is what
 * names windows everywhere), then local changes, then the pull requests and pipelines, then the
 * ticket cards. The Azure DevOps page is offered beside the list, not on it — and review owns a
 * change tab rather than a card, so the two come last with leftovers and do not disturb the
 * cards' order.
 *
 * This is the explicit composition that replaced the loader: the modules are ordinary code,
 * imported here and nowhere discovered. A workspace's `extensions` list still decides which of
 * them apply to it.
 */
export const includedIntegrations: readonly IncludedIntegration[] = [
  agents,
  git,
  github,
  jira,
  githubIssues,
  azureDevops,
  leftovers,
  review,
  notes,
];
