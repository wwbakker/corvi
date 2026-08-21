import { basename } from "node:path";
import type { Change, Integration, Widget, WidgetItem, WidgetState } from "../types.ts";
import { prItem, createPr } from "./github.ts";
import { checkItems } from "./checks.ts";
import { pipelineItems } from "./azure.ts";

/** Pull requests and the pipelines they trigger, per repository: one question ("is this change
 * green?") answered in one card, rather than split across two vendors. */
/** repository > pull request > pipeline > runs, as one collapsible tree per repository. */
async function repoItem(
  change: Change,
  repo: string,
): Promise<{ item: WidgetItem; prs: number; runs: number }> {
  const { number, item: pr } = await prItem(change, repo);
  // Pipelines run on the PR merge ref once a PR exists, so the two are looked up together.
  const { items: azure, count } = await pipelineItems(change, repo, number);
  // Nothing found in Azure DevOps does not mean nothing ran: a repository can be built by
  // GitHub Actions, or by pipelines in another Azure project than the configured one. The pull
  // request itself knows about all of them, so fall back to what it reports.
  const pipelines = count === 0 && number ? await fallbackChecks(change, repo, number, azure) : azure;
  const item: WidgetItem = {
    label: basename(repo),
    state: worst([pr, ...pipelines]),
    children: [{ ...pr, children: pipelines }],
  };
  return { item, prs: number ? 1 : 0, runs: count };
}

async function fallbackChecks(
  change: Change,
  repo: string,
  number: number,
  azure: WidgetItem[],
): Promise<WidgetItem[]> {
  const checks = await checkItems(change, repo, number);
  return checks.length ? checks : azure;
}

const worst = (items: WidgetItem[]): WidgetState =>
  items.some((i) => i.state === "error")
    ? "error"
    : items.some((i) => i.state === "pending")
      ? "pending"
      : items.some((i) => i.state === "warn")
        ? "warn"
        : items.some((i) => i.state === "ok")
          ? "ok"
          : "none";

export const ci: Integration = {
  name: "ci",
  title: "CI",
  wide: true,

  async repoStatus(change: Change, repo: string): Promise<WidgetItem[]> {
    return [(await repoItem(change, repo)).item];
  },

  async run(change: Change, action: string, repo?: string): Promise<void> {
    if (action !== "create") throw new Error(`unknown ci action: ${action}`);
    if (!repo) throw new Error("repo required");
    await createPr(change, repo);
  },
};
