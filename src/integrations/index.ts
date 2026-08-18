import type { Change, Integration, Widget } from "../types.ts";
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

/** Run every integration's provisioning step for a freshly created change. Failures are
 * collected rather than thrown: the change already exists, and a half-provisioned change is
 * fixable from the dashboard once you can see what went wrong. */
export async function provision(change: Change): Promise<ProvisionResult[]> {
  const results: ProvisionResult[] = [];
  for (const i of Object.values(integrations)) {
    if (!i.provision) continue;
    try {
      await i.provision(change);
      results.push({ integration: i.name, ok: true });
    } catch (e) {
      results.push({ integration: i.name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/** One integration's widget; a thrown error becomes a red card rather than a failed request. */
export async function statusOne(integration: Integration, change: Change): Promise<Widget> {
  try {
    return await integration.status(change);
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
