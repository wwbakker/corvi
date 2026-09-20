import { Effect } from "effect";
import type { Change } from "../../domain/change.ts";
import { listChanges, writeChange } from "./store.ts";
import { includedTitleSources } from "../../integrations/overview.ts";
import { capabilitiesLayer } from "../../extension-host/services.ts";
import { workspaceOf } from "../../workspace/server/index.ts";

/**
 * What to call a change on the overview: its ticket's summary, which says what the work is,
 * rather than the branch, which says how it is spelled.
 *
 * The summary is stored in change.json when it is first read, so the list — which must be
 * instant, it is the front page — already carries it, and an archived change keeps its name
 * even after the ticket is gone or its vendor is unreachable. This refreshes those labels, and
 * is asked for separately by the browser once the list is up.
 *
 * Whose summaries to fetch is the extensions' business: each workspace's title sources are
 * asked for the changes they claim, one question per workspace, inside that workspace's context
 * so every subprocess carries its environment. A source that cannot answer contributes nothing
 * — a vendor being down is not a reason to blank the names.
 */
export const refreshTitles = (): Effect.Effect<Record<string, string>, unknown> =>
  Effect.gen(function* () {
    const changes = yield* listChanges();
    // A title you wrote yourself is not a stale copy of the ticket's, so its ticket is not asked
    // about and its name is left alone.
    const asking = changes.filter((c) => !c.titleEdited);

    // One question per workspace: two clients' tickets answer the same key differently, and
    // both are right.
    const byWorkspace = new Map<string, Change[]>();
    for (const change of asking) {
      const key = workspaceOf(change).id;
      (byWorkspace.get(key) ?? byWorkspace.set(key, []).get(key)!).push(change);
    }

    const answered = yield* Effect.forEach(
      [...byWorkspace.values()],
      (group) =>
        Effect.gen(function* () {
          const workspace = workspaceOf(group[0]!);
          const titles = new Map<string, string>();
          for (const { name, contribution: source } of includedTitleSources(workspace)) {
            const claimed = group.filter((c) => source.applies(c));
            if (claimed.length === 0) continue;
            // A source that fails contributes nothing: a vendor being down is not a reason to
            // blank the names.
            const found = yield* source.lookup(claimed).pipe(
              Effect.provide(capabilitiesLayer(workspace, name)),
              Effect.catchAll(() => Effect.succeed(new Map<string, string>())),
            );
            for (const [id, summary] of found) titles.set(id, summary);
          }
          return titles;
        }),
      { concurrency: "unbounded" },
    );
    const known = new Map<string, string>(answered.flatMap((m) => [...m]));

    const titles: Record<string, string> = {};
    yield* Effect.forEach(
      changes,
      (change: Change) =>
        Effect.gen(function* () {
          // A ticket the vendor did not answer for keeps whatever was stored: a renamed ticket is
          // worth following, a broken CLI is not worth forgetting a name over.
          const summary = change.titleEdited ? change.title : known.get(change.id) ?? change.title;
          if (!summary) return;
          titles[change.id] = summary;
          if (summary !== change.title) yield* writeChange({ ...change, title: summary });
        }),
      { concurrency: "unbounded" },
    );
    return titles;
  });
