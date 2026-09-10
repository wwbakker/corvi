import { basename } from "node:path";
import { Effect } from "effect";
import type { Change } from "./types.ts";
import { prItem } from "./integrations/github.ts";
import { descriptionSectionsFor } from "./extensions/index.ts";
import { capabilitiesLayer } from "./extensions/services.ts";
import { workspaceOf } from "./workspaces.ts";

/**
 * The text to paste into a pull request: the tickets it implements — whatever the extensions
 * that name this change's work say they are — then a link to the pull request in every
 * repository of this change, so a reviewer can walk the whole thing. A repository without a
 * pull request yet is named instead, so the list stays complete.
 *
 * Kept as the pure formatter it always was, so the join stays testable without a vendor: the
 * heading arrives already composed, and this puts it over the links.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function describeChange(
  jira: string | undefined,
  summary: string | undefined,
  links: string[],
): string {
  const heading = [jira, summary].filter(Boolean).join(" - ");
  return `${heading}\n${links.join("\n")}\n`;
}

export const prDescription = (change: Change): Effect.Effect<string> =>
  Effect.gen(function* () {
    // The heading, one contributed part per extension that claims this change, joined with
    // " - " — which is what a ticket key and its summary were joined with when there was only
    // ever one ticket. A section that fails is absent, not a failed request.
    const workspace = workspaceOf(change);
    const capabilities = capabilitiesLayer(workspace);
    const parts = yield* Effect.forEach(
      descriptionSectionsFor(workspace),
      (section) =>
        section.heading(change).pipe(
          Effect.provide(capabilities),
          Effect.catchAll(() => Effect.succeed(undefined)),
        ),
      { concurrency: "unbounded" },
    );
    const heading = parts.filter((p): p is string => Boolean(p)).join(" - ") || undefined;

    const links = yield* Effect.forEach(
      change.repos,
      (repo) => Effect.map(prItem(change, repo), (found) => found.item.url ?? basename(repo)),
      // The old Promise.all was unbounded, so this stays unbounded.
      { concurrency: "unbounded" },
    );
    return describeChange(heading, undefined, links);
  });
