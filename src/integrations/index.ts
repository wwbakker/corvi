import { isFinished, type Change, type Integration, type Widget, type WidgetItem } from "../types.ts";
import { applies } from "../workspaces.ts";
import { git } from "./git.ts";
import { jira } from "./jira.ts";
import { ci } from "./ci.ts";

/** The whole "component system": a lookup table. Add an entry to add a component. */
/** Insertion order is dashboard order: the ticket first, then local work, then CI. */
export const integrations: Record<string, Integration> = {
  [jira.name]: jira,
  [git.name]: git,
  [ci.name]: ci,
};

export type ProvisionResult = { integration: string; ok: boolean; error?: string };

/** The components a change's dashboard shows: the ones its workspace has at all. */
export const integrationsFor = (change: Change) =>
  Object.values(integrations).filter((i) => applies(i.name, change));

/** Run every integration's provisioning step for a freshly created change. Failures are
 * collected rather than thrown: the change already exists, and a half-provisioned change is
 * fixable from the dashboard once you can see what went wrong. */
export async function provision(change: Change): Promise<ProvisionResult[]> {
  const results: ProvisionResult[] = [];
  for (const i of Object.values(integrations)) {
    // A context without Jira has no ticket to move: provisioning it would be an error about a
    // thing this change was never going to have.
    if (!i.provision || !applies(i.name, change)) continue;
    try {
      await i.provision(change);
      results.push({ integration: i.name, ok: true });
    } catch (e) {
      results.push({ integration: i.name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/**
 * A change that is over is one to read, not one to act on.
 *
 * Its worktrees are gone and its directory is in the archive, so "Create worktree" and the rest
 * offer to half-revive something that has been finished — the row is worth keeping, the button is
 * not. The `⋯` menu stays: opening the repository a change touched is still a reasonable thing to
 * want afterwards.
 */
function readOnly(items: WidgetItem[]): WidgetItem[] {
  return items.map(({ actions, children, ...item }) => ({
    ...item,
    ...(children ? { children: readOnly(children) } : {}),
  }));
}

/** One integration's widget; a thrown error becomes a red card rather than a failed request. */
export async function statusOne(integration: Integration, change: Change): Promise<Widget> {
  try {
    if (!integration.status) throw new Error(`${integration.name} reports per repository`);
    const widget = await integration.status(change);
    return isFinished(change) ? { ...widget, items: readOnly(widget.items) } : widget;
  } catch (e) {
    return {
      integration: integration.name,
      title: integration.title,
      state: "error",
      summary: e instanceof Error ? e.message : String(e),
      items: [],
    };
  }
}

/** One repository's rows, for the components that report per repository. A failure becomes a
 * red row for that repository only: the others keep loading. */
export async function repoStatusOf(
  integration: Integration,
  change: Change,
  repo: string,
): Promise<WidgetItem[]> {
  try {
    if (!integration.repoStatus) throw new Error(`${integration.name} has no per-repository view`);
    const items = await integration.repoStatus(change, repo);
    return isFinished(change) ? readOnly(items) : items;
  } catch (e) {
    return [
      {
        label: repo.split("/").pop() ?? repo,
        detail: e instanceof Error ? e.message : String(e),
        state: "error",
      },
    ];
  }
}
