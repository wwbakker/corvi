import { Effect, Either } from "effect";
import { isFinished, type Change, type Widget, type WidgetItem } from "../types.ts";
import { workspaceOf } from "../workspaces.ts";
import { messageOf } from "../effect/support.ts";
import { capabilitiesLayer } from "./services.ts";
import { extensionsFor } from "./selectors.ts";
import type { Capabilities, Card } from "./api.ts";

/**
 * Running what the extensions contributed: the change-created hooks, a card's widget, one
 * repository's rows, and a card's actions. Each effect is run as the change's workspace, and
 * each failure is a value the caller can show — a red card, a red row, a collected result —
 * never a failed request.
 */

/** Run one contributed effect as the change's workspace: the capabilities layer provides the
 * Workspace tag, Shell, Cache, Settings and Bus, and the effect's requirements are satisfied
 * through the R channel — nothing here bridges across a promise seam, because there is none. */
const asWorkspace = <A, E>(
  change: Change,
  effect: Effect.Effect<A, E, Capabilities>,
): Effect.Effect<A, E> => Effect.provide(effect, capabilitiesLayer(workspaceOf(change)));

export type ProvisionResult = { integration: string; ok: boolean; error?: string };

/**
 * Run every `change:created` hook for a freshly created change. Failures are collected rather
 * than thrown: the change already exists, and a half-provisioned change is fixable from the
 * dashboard once you can see what went wrong. A hook that failed stops its own extension's
 * later hooks — they would build on a half-done job — but never the extensions after it.
 */
export const provisionEffect = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    const results: ProvisionResult[] = [];
    for (const ext of extensionsFor(workspaceOf(change))) {
      for (const handler of ext.changeCreated) {
        const outcome = yield* asWorkspace(change, handler(change)).pipe(
          Effect.map(() => ({ integration: ext.name, ok: true }) as ProvisionResult),
          Effect.catchAll((e) => Effect.succeed({ integration: ext.name, ok: false, error: messageOf(e) })),
        );
        results.push(outcome);
        if (!outcome.ok) break;
      }
    }
    return results;
  });

/** Promise facade over provisionEffect, in the old signature. Kept for the test suite, which
 * must pass unmodified; the server uses the effect directly. */
export const provision = (change: Change): Promise<ProvisionResult[]> =>
  Effect.runPromise(provisionEffect(change));

/** One card's widget; a failed effect is a red card carrying the error's message, never a
 * failed request. A finished change's rows lose their actions — reading, not acting. The
 * name is the extension's own, which the browser knows the card by; the host has it wherever
 * it found the card, and the contract keeps the Card name-free. */
export const statusOneEffect = (name: string, card: Card, change: Change): Effect.Effect<Widget> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      asWorkspace(
        change,
        card.status
          ? card.status(change)
          : Effect.fail(new Error(`${card.title} reports per repository`)),
      ),
    );
    if (Either.isLeft(found)) {
      const e = found.left;
      return {
        integration: name,
        title: card.title,
        state: "error",
        summary: messageOf(e),
        items: [],
      };
    }
    const widget = found.right;
    return isFinished(change) ? { ...widget, items: readOnly(widget.items) } : widget;
  });

/** One repository's rows, for the cards that report per repository. A failed effect is a red
 * row for that repository only: the others keep loading. */
export const repoStatusOfEffect = (
  card: Card,
  change: Change,
  repo: string,
): Effect.Effect<WidgetItem[]> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      asWorkspace(
        change,
        card.repoStatus
          ? card.repoStatus(change, repo)
          : Effect.fail(new Error(`${card.title} has no per-repository view`)),
      ),
    );
    if (Either.isLeft(found)) {
      const e = found.left;
      return [
        {
          label: repo.split("/").pop() ?? repo,
          detail: messageOf(e),
          state: "error",
        },
      ];
    }
    const items = found.right;
    return isFinished(change) ? readOnly(items) : items;
  });

/** Promise facade over repoStatusOfEffect, in the old signature. Kept for the test suite,
 * which must pass unmodified; the server uses the effect directly. */
export const repoStatusOf = (card: Card, change: Change, repo: string): Promise<WidgetItem[]> =>
  Effect.runPromise(repoStatusOfEffect(card, change, repo));

/** Perform an action a card's rows advertised — the POST `/api/changes/:id/:integration/:action`
 * path. A finished change refuses: the buttons are gone from its dashboard, but a page may
 * have been open since before it finished, and this is where the truth lives. */
export const runCardEffect = (
  card: Card,
  change: Change,
  action: string,
  arg: string | undefined,
): Effect.Effect<void, unknown> =>
  asWorkspace(
    change,
    card.run
      ? card.run(change, action, arg)
      : Effect.fail(new Error(`${card.title} has no actions`)),
  );

/** The widget's `integration` field is the identity the browser knows the card by — the
 * extension's name, carried by the caller (see statusOneEffect). */

/**
 * A change that is over is one to read, not one to act on.
 *
 * Its worktrees are gone and its directory is in the archive, so "Create worktree" and the rest
 * offer to half-revive something that has been finished — the row is worth keeping, the button is
 * not. The `⋯` menu stays: opening the repository a change touched is still a reasonable thing to
 * want afterwards.
 */
function readOnly(items: WidgetItem[]): WidgetItem[] {
  return items.map(({ actions, children, ...item }) => ({
    ...item,
    ...(children ? { children: readOnly(children) } : {}),
  }));
}
