import { basename } from "node:path";
import type { Change, Integration, Widget, WidgetItem, WidgetState } from "../types.ts";
import { prItem, createPr } from "./github.ts";
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
  const { items: pipelines, count } = await pipelineItems(change, repo, number);
  const item: WidgetItem = {
    label: basename(repo),
    state: worst([pr, ...pipelines]),
    children: [{ ...pr, children: pipelines }],
  };
  return { item, prs: number ? 1 : 0, runs: count };
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

  async status(change: Change): Promise<Widget> {
    const per = await Promise.all(change.repos.map((r) => repoItem(change, r)));
    const items = per.map((p) => p.item);
    const prs = per.reduce((n, p) => n + p.prs, 0);
    const runs = per.reduce((n, p) => n + p.runs, 0);
    return {
      integration: "ci",
      title: ci.title,
      state: worst(items),
      summary: `${prs} pull request(s), ${runs} pipeline run(s)`,
      items,
    };
  },

  async run(change: Change, action: string, repo?: string): Promise<void> {
    if (action !== "create") throw new Error(`unknown ci action: ${action}`);
    if (!repo) throw new Error("repo required");
    await createPr(change, repo);
  },
};
