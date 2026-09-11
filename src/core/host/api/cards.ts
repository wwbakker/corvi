import type { Effect } from "effect";
import type { Change } from "../../domain/change.ts";
import type { Widget, WidgetItem } from "../../domain/widget.ts";
import type { Capabilities } from "./capabilities.ts";

/** A dashboard card. The card's identity on the routes is the extension's own name, so there
 * is one card per extension; a failure of `status` or `repoStatus` is a red card or a red row
 * carrying the error's message — fail with whatever typed error you like. */
export type Card = {
  title: string;
  /** Ask for the tall column of its own on a wide window (the CI card's tree). */
  wide?: boolean;
  /** Whole-widget status; a card without it reports per repository. */
  status?: (change: Change) => Effect.Effect<Widget, unknown, Capabilities>;
  /** Rows for one repository, fetched a repository at a time, so a change with many
   * repositories fills in one by one instead of all at the end. */
  repoStatus?: (change: Change, repo: string) => Effect.Effect<WidgetItem[], unknown, Capabilities>;
  /** Perform an action a row advertised (`arg` is what the row handed back). */
  run?: (
    change: Change,
    action: string,
    arg: string | undefined,
  ) => Effect.Effect<void, unknown, Capabilities>;
};
