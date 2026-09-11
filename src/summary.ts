import { Effect } from "effect";
import { worst } from "./core/domain/widget.ts";
import type { Change, ChangeSummary } from "./core/domain/change.ts";
import type { SummaryFact } from "./core/domain/widget.ts";
import { listWindows } from "./terminal.ts";
import { summaryContributorsFor } from "./core/host/index.ts";
import { capabilitiesLayer } from "./core/host/services.ts";
import { workspaceOf } from "./workspaces.ts";

export type { ChangeSummary };

// Pure, and extension code needs it without importing this module through the host, so it is
// defined in core/domain/widget.ts; re-exported here for callers of this module.
export { worst };

/**
 * What the overview's card says about a change: what the core knows about its terminals, plus
 * what the extensions say.
 *
 * Deliberately cheap: the terminals come from one tmux call, and each extension is asked once,
 * in load order, inside the change's own workspace — so every subprocess carries its
 * environment. A contributor that fails contributes nothing: a vendor being down is not a
 * reason to blank the card, let alone fail the request. The icon's verdict is the worst of
 * what was offered, and "none" when nobody offered one.
 */
export const summaryOf = (change: Change): Effect.Effect<ChangeSummary, unknown> =>
  Effect.gen(function* () {
    // The core's own fact: tmux stays core, and busy is a presented fact — the merge in
    // terminal.ts says which windows are work.
    const windows = yield* listWindows(change.id);
    const busy = windows.filter((w) => w.busy).length;
    const terminals: SummaryFact = {
      id: "terminals",
      label: busy > 0 ? `${busy} terminal process${busy === 1 ? "" : "es"} active` : "terminals idle",
      state: busy > 0 ? "ok" : "none",
    };
    // Every contributor in load order, each inside its workspace's context; one that fails
    // contributes nothing, never a failed request.
    const answered = yield* Effect.forEach(
      summaryContributorsFor(workspaceOf(change)),
      (contributor) =>
        contributor.facts(change).pipe(
          Effect.provide(capabilitiesLayer(workspaceOf(change))),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: "unbounded" },
    );
    const contributions = answered.filter((c) => c !== undefined);
    return {
      facts: [terminals, ...contributions.flatMap((c) => c.facts)],
      // One red build decides the colour; nothing said is its own state, not green.
      state: worst(contributions.flatMap((c) => (c.state ? [c.state] : []))),
    };
  });
