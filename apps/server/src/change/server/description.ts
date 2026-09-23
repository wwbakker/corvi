import { basename } from "node:path";
import { Effect } from "effect";
import type { Change } from "../../domain/change.ts";
import { prItem } from "@corvi/github/client";
import type { Cache, GitFacts } from "@corvi/contracts/capabilities";
import type { Changes } from "../../integrations/api/capabilities.ts";
import type { BadRequestError } from "@corvi/contracts/errors";
import { includedDescriptionSections } from "../../integrations/overview.ts";
import { capabilitiesLayer } from "../../integrations/services.ts";
import { workspaceOf } from "../../workspace/server/index.ts";

/**
 * The text to paste into a pull request: the tickets it implements — whatever the extensions
 * that name this change's work say they are — then a link to the pull request in every
 * repository of this change, so a reviewer can walk the whole thing. A repository without a
 * pull request yet is named instead, so the list stays complete.
 *
 * A pure formatter, so the join stays testable without a vendor: the heading arrives already
 * composed, and this puts it over the links.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function describeChange(
  ticket: string | undefined,
  summary: string | undefined,
  links: string[],
): string {
  const heading = [ticket, summary].filter(Boolean).join(" - ");
  return `${heading}\n${links.join("\n")}\n`;
}

export const prDescription = (change: Change): Effect.Effect<string, BadRequestError, Changes | GitFacts | Cache> =>
  Effect.gen(function* () {
    // The heading, one contributed part per extension that claims this change, joined with
    // " - ". A section that fails is absent, not a failed request.
    const workspace = workspaceOf(change);
    const parts = yield* Effect.forEach(
      includedDescriptionSections(workspace),
      ({ name, contribution: section }) =>
        section.heading(change).pipe(
          Effect.provide(capabilitiesLayer(workspace, name)),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: "unbounded" },
    );
    const heading = parts.filter((p): p is string => Boolean(p)).join(" - ") || undefined;

    const links = yield* Effect.forEach(
      change.checkouts ?? [],
      (spec) => Effect.map(prItem(change, spec.path), (found) => found.item.url ?? basename(spec.path)),
      // Unbounded concurrency is deliberate: these per-repo lookups are independent.
      { concurrency: "unbounded" },
    );
    return describeChange(heading, undefined, links);
  });
