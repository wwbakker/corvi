import { Effect } from "effect";
import type { Change } from "./types.ts";
import { listChangesEffect, writeChangeEffect } from "./changes.ts";
import { issuesByKeys, siteOf, type Issue, type Site } from "./integrations/jira.ts";
import { usesJira, workspaceOf } from "./workspaces.ts";

/** How the summaries are fetched. A parameter so a test does not need a Jira. */
export type Lookup = (keys: string[], site?: Site) => Promise<Map<string, Issue>>;

// TODO-MIGRATE — the lookup defaults to integrations/jira.ts's issuesByKeys, another worker's
// task: the Promise facade wrapped in Effect.tryPromise until that lands, then swept by the
// server task. siteOf stays direct — it is pure string shaping, nothing to migrate.
const lookupEffect = (
  lookup: Lookup,
  keys: string[],
  site?: Site,
): Effect.Effect<Map<string, Issue>, unknown> =>
  Effect.tryPromise({ try: () => lookup(keys, site), catch: (e) => e });

/**
 * What to call a change on the overview: its ticket's summary, which says what the work is,
 * rather than the branch, which says how it is spelled.
 *
 * The summary is stored in change.json when it is first read, so the list — which must be
 * instant, it is the front page — already carries it, and an archived change keeps its name
 * even after the ticket is gone or Jira is unreachable. This refreshes those labels in one
 * query for the whole page, and is asked for separately by the browser once the list is up.
 */
export const refreshTitlesEffect = (
  lookup: Lookup = issuesByKeys,
): Effect.Effect<Record<string, string>, unknown> =>
  Effect.gen(function* () {
    const changes = yield* listChangesEffect();
    // A title you wrote yourself is not a stale copy of the ticket's, so its ticket is not asked
    // about and its name is left alone. A context without Jira has nothing to ask.
    const asking = changes.filter(
      (c) => c.jira && !c.titleEdited && usesJira(workspaceOf(c)),
    );

    // One query per site: two clients' Jiras answer "PROJ-1" differently, and both are right.
    const bySite = new Map<string, Change[]>();
    for (const change of asking) {
      const key = workspaceOf(change).id;
      (bySite.get(key) ?? bySite.set(key, []).get(key)!).push(change);
    }
    const found = yield* Effect.forEach(
      [...bySite.values()],
      (group) =>
        // A Jira that does not answer leaves every stored title standing: the queries run per
        // site, and one site being down is not a reason to blank the others. What
        // `.catch(() => new Map())` did.
        lookupEffect(lookup, [...new Set(group.map((c) => c.jira!))], siteOf(group[0]!)).pipe(
          Effect.catchAll(() => Effect.succeed(new Map<string, Issue>())),
        ),
      { concurrency: "unbounded" },
    );
    const issues = new Map<string, Issue>(found.flatMap((m) => [...m]));

    const titles: Record<string, string> = {};
    yield* Effect.forEach(
      changes,
      (change: Change) =>
        Effect.gen(function* () {
          // A ticket Jira did not answer for keeps whatever was stored: a renamed ticket is worth
          // following, a broken CLI is not worth forgetting a name over.
          const summary = change.titleEdited
            ? change.title
            : (change.jira && issues.get(change.jira)?.summary) || change.title;
          if (!summary) return;
          titles[change.id] = summary;
          if (summary !== change.title) yield* writeChangeEffect({ ...change, title: summary });
        }),
      { concurrency: "unbounded" },
    );
    return titles;
  });

/** TODO-MIGRATE */
export const refreshTitles = (lookup: Lookup = issuesByKeys): Promise<Record<string, string>> =>
  Effect.runPromise(refreshTitlesEffect(lookup));
