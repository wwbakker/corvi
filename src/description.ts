import { basename } from "node:path";
import type { Change } from "./types.ts";
import { issueByKey } from "./integrations/jira.ts";
import { prItem } from "./integrations/github.ts";

/**
 * The text to paste into a pull request: the ticket it implements, then a link to the pull
 * request in every repository of this change, so a reviewer can walk the whole thing. A
 * repository without a pull request yet is named instead, so the list stays complete.
 */
export function describeChange(
  jira: string | undefined,
  summary: string | undefined,
  links: string[],
): string {
  const heading = [jira, summary].filter(Boolean).join(" - ");
  return `${heading}\n${links.join("\n")}\n`;
}

export async function prDescription(change: Change): Promise<string> {
  const [issue, links] = await Promise.all([
    change.jira ? issueByKey(change.jira) : undefined,
    Promise.all(
      change.repos.map(async (repo) => (await prItem(change, repo)).item.url ?? basename(repo)),
    ),
  ]);
  return describeChange(change.jira, issue?.summary, links);
}
