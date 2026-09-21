import { Effect, Either } from "effect";
import { isFinished, type Change } from "../domain/change.ts";
import type { Widget, WidgetItem } from "../domain/widget.ts";
import { workspaceOf } from "../workspace/server/index.ts";
import { messageOf } from "../capabilities/effect/support.ts";
import { BadRequestError } from "../capabilities/effect/errors.ts";
import { capabilitiesLayer } from "./services.ts";
import type { Capabilities, Card } from "../integrations/types.ts";

/**
 * Running what the extensions contributed: a card's widget, one repository's rows, and a card's
 * actions. Each effect is run as the change's workspace with the contributing extension's name
 * bound into the `ExtensionStore`, and each failure is a value the caller can show — a red card,
 * a red row — never a failed request.
 */

/** Run one contributed effect as the change's workspace: the capabilities layer provides the
 * Workspace tag, Shell, Cache, Settings, Bus and the name-bound `ExtensionStore`, and the
 * effect's requirements are satisfied through the R channel. */
const asWorkspace = <A, E>(
  change: Change,
  effect: Effect.Effect<A, E, Capabilities>,
  extension?: string,
): Effect.Effect<A, E> =>
  Effect.provide(effect, capabilitiesLayer(workspaceOf(change), extension));

/** One card's widget; a failed effect is a red card carrying the error's message, never a
 * failed request. A finished change's rows lose their actions — reading, not acting. The
 * name is the extension's own, which the browser knows the card by; the host has it wherever
 * it found the card, and the contract keeps the Card name-free. */
export const statusOne = (name: string, card: Card, change: Change): Effect.Effect<Widget> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      asWorkspace(
        change,
        card.status
          ? card.status(change)
          : Effect.fail(new BadRequestError({ message: `${card.title} reports per repository` })),
        name,
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
export const repoStatusOf = (
  name: string,
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
          : Effect.fail(new BadRequestError({ message: `${card.title} has no per-repository view` })),
        name,
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

/** Perform an action a card's rows advertised — the POST `/api/changes/:id/:card/:action`
 * path. A finished change refuses: the buttons are gone from its dashboard, but a page may
 * have been open since before it finished, and this is where the truth lives. */
export const runCard = (
  name: string,
  card: Card,
  change: Change,
  action: string,
  arg: string | undefined,
): Effect.Effect<void, unknown> =>
  asWorkspace(
    change,
    card.run
      ? card.run(change, action, arg)
      : Effect.fail(new BadRequestError({ message: `${card.title} has no actions` })),
    name,
  );

/** The widget's `integration` field is the identity the browser knows the card by — the
 * extension's name, carried by the caller (see statusOne). */

/**
 * A change that is over is one to read, not one to act on.
 *
 * Its worktrees are gone and its directory is in the archive, so "Create worktree" and the rest
 * offer to half-revive something that has been finished — the row is worth keeping, the button is
 * not. The `⋯` menu stays: opening the repository a change touched is still a reasonable thing
 * to want afterwards.
 */
function readOnly(items: WidgetItem[]): WidgetItem[] {
  return items.map(({ actions, children, ...item }) => ({
    ...item,
    ...(children ? { children: readOnly(children) } : {}),
  }));
}
