import { basename } from "node:path";
import { Effect } from "effect";
import type { Change } from "./types.ts";
import { issueByKeyEffect } from "./integrations/jira.ts";
import { prItemEffect } from "./integrations/github.ts";

/**
 * The text to paste into a pull request: the ticket it implements, then a link to the pull
 * request in every repository of this change, so a reviewer can walk the whole thing. A
 * repository without a pull request yet is named instead, so the list stays complete.
 */
// TODO-MIGRATE — pure and synchronous: nothing for an Effect to wrap.
export function describeChange(
  jira: string | undefined,
  summary: string | undefined,
  links: string[],
): string {
  const heading = [jira, summary].filter(Boolean).join(" - ");
  return `${heading}\n${links.join("\n")}\n`;
}

export const prDescriptionEffect = (change: Change): Effect.Effect<string> =>
  Effect.gen(function* () {
    const [issue, links] = yield* Effect.all([
      change.jira ? issueByKeyEffect(change.jira) : Effect.succeed(undefined),
      Effect.forEach(
        change.repos,
        (repo) => Effect.map(prItemEffect(change, repo), (found) => found.item.url ?? basename(repo)),
        // The old Promise.all was unbounded, so this stays unbounded.
        { concurrency: "unbounded" },
      ),
    ]);
    return describeChange(change.jira, issue?.summary, links);
  });

/** TODO-MIGRATE — Promise facade over prDescriptionEffect. */
export const prDescription = (change: Change): Promise<string> =>
  Effect.runPromise(prDescriptionEffect(change));
