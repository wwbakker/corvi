import type { Effect } from "effect";
import type { Change } from "../../domain/change.ts";
import type { SummaryFact, WidgetState } from "../../domain/widget.ts";
import type { Capabilities } from "./capabilities.ts";

/** One fact on a change's overview card. Defined with the dashboard's vocabulary in
 * src/domain/widget.ts; re-exported so this contract stays the one import an extension
 * needs. */
export type { SummaryFact };

/** Names the changes it can title, and answers with summaries. A failed lookup contributes
 * nothing — stored titles stand. Asked once per workspace, with that workspace's claimed
 * changes. */
export type TitleSource = {
  /** Pure: which of these changes are this source's to name. Changes whose title was
   * written by hand are filtered out before this is asked. */
  applies(change: Change): boolean;
  /** Summaries, keyed by change id — not by ticket key, which is the source's own business. */
  lookup(changes: Change[]): Effect.Effect<Map<string, string>, unknown, Capabilities>;
};

/** What one contributor says about a change: facts for the overview card, and — when it has
 * an opinion — the verdict for the change's status icon in the navigation, which takes the
 * worst of what is offered. A failed contribution contributes nothing. */
export type SummaryContribution = {
  facts: SummaryFact[];
  state?: WidgetState;
};

export type SummaryContributor = {
  facts(change: Change): Effect.Effect<SummaryContribution, unknown, Capabilities>;
};

/** What cancelling this change would leave behind, said so you can act on it: the open
 * ticket, the open pull requests. One string per end, phrased for a person. A failed
 * contribution contributes nothing. */
export type LooseEndContributor = {
  looseEnds(change: Change): Effect.Effect<string[], unknown, Capabilities>;
};

/** A part of the pull-request description. Heading parts are joined with " - " into the
 * first line; a section that has nothing to say returns undefined and is simply absent. */
export type DescriptionSection = {
  heading(change: Change): Effect.Effect<string | undefined, unknown, Capabilities>;
};
