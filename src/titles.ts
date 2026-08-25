import type { Change } from "./types.ts";
import { listChanges, writeChange } from "./changes.ts";
import { issuesByKeys, type Issue } from "./integrations/jira.ts";

/** How the summaries are fetched. A parameter so a test does not need a Jira. */
export type Lookup = (keys: string[]) => Promise<Map<string, Issue>>;

/**
 * What to call a change on the overview: its ticket's summary, which says what the work is,
 * rather than the branch, which says how it is spelled.
 *
 * The summary is stored in change.json when it is first read, so the list — which must be
 * instant, it is the front page — already carries it, and an archived change keeps its name
 * even after the ticket is gone or Jira is unreachable. This refreshes those labels in one
 * query for the whole page, and is asked for separately by the browser once the list is up.
 */
export async function refreshTitles(lookup: Lookup = issuesByKeys): Promise<Record<string, string>> {
  const changes = await listChanges();
  const keys = [...new Set(changes.map((c) => c.jira).filter((k): k is string => Boolean(k)))];
  const issues = await lookup(keys).catch(() => new Map<string, Issue>());

  const titles: Record<string, string> = {};
  await Promise.all(
    changes.map(async (change: Change) => {
      // A ticket Jira did not answer for keeps whatever was stored: a renamed ticket is worth
      // following, a broken CLI is not worth forgetting a name over.
      const summary = (change.jira && issues.get(change.jira)?.summary) || change.title;
      if (!summary) return;
      titles[change.id] = summary;
      if (summary !== change.title) await writeChange({ ...change, title: summary });
    }),
  );
  return titles;
}
