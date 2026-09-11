import { Effect, Either } from "effect";
import { isFinished, type Change, type ChangeDraft } from "../domain/change.ts";
import type { Widget, WidgetItem } from "../domain/widget.ts";
import { workspaceById, workspaceOf } from "../../workspaces.ts";
import { messageOf } from "../../effect/support.ts";
import { BadRequestError, isIweError, type IweError } from "../../effect/errors.ts";
import { capabilitiesLayer } from "./services.ts";
import { extensionsFor } from "./selectors.ts";
import type { LoadedExtension } from "./registry.ts";
import type {
  Capabilities,
  Card,
  ChangeAfterHook,
  ChangeBeforeHook,
} from "./api.ts";

/**
 * Running what the extensions contributed: the lifecycle hooks, a card's widget, one
 * repository's rows, and a card's actions. Each effect is run as the change's workspace with the
 * contributing extension's name bound into the `ExtensionStore`, and each failure is a value the
 * caller can show — a red card, a red row, a collected result — never a failed request, except
 * where a before-hook vetoes an operation on purpose.
 */

/** Map any failure to the taxonomy, so a before-hook's veto travels as a typed error the route
 * can turn into a status code and the wizard can show. A hook that failed with one of ours keeps
 * its tag (a `ConflictError` stays a 409); anything else becomes `BadRequestError` carrying its
 * message. */
const veto = (e: unknown): IweError =>
  isIweError(e) ? e : new BadRequestError({ message: messageOf(e) });

/** Run one contributed effect as the change's workspace: the capabilities layer provides the
 * Workspace tag, Shell, Cache, Settings, Bus and the name-bound `ExtensionStore`, and the
 * effect's requirements are satisfied through the R channel. */
const asWorkspace = <A, E>(
  change: Change,
  effect: Effect.Effect<A, E, Capabilities>,
  extension?: string,
): Effect.Effect<A, E> =>
  Effect.provide(effect, capabilitiesLayer(workspaceOf(change), extension));

/** The same, for a moment before the change exists (creation), where only the draft's workspace
 * is known. */
const asWorkspaceById = <A, E>(
  workspace: string | undefined,
  effect: Effect.Effect<A, E, Capabilities>,
  extension?: string,
): Effect.Effect<A, E> =>
  Effect.provide(effect, capabilitiesLayer(workspaceById(workspace), extension));

const afterHooksFor = (
  ext: LoadedExtension,
  event: "change:created" | "change:completed" | "change:cancelled",
): ChangeAfterHook[] =>
  event === "change:created"
    ? ext.changeCreated
    : event === "change:completed"
      ? ext.changeCompleted
      : ext.changeCancelled;

const beforeHooksFor = (
  ext: LoadedExtension,
  event: "change:completing" | "change:cancelling",
): ChangeBeforeHook[] =>
  event === "change:completing" ? ext.changeCompleting : ext.changeCancelling;

/** A patch with its explicit `undefined`s dropped: `{ id: undefined }` from a hook leaves the
 * draft alone rather than erasing the id the wizard collected. */
const definedOnly = (patch: Partial<ChangeDraft>): Partial<ChangeDraft> => {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<ChangeDraft>;
};

/** Run every `change:creating` hook, in extension load order, chaining their patches: each hook
 * sees the draft the one before it produced. The returned draft is what the core validates and
 * writes — the hooks decide what the change is, they never bypass an invariant. The first
 * failure vetoes the create. */
export const applyCreatingHooks = (draft: ChangeDraft): Effect.Effect<ChangeDraft, IweError> =>
  Effect.gen(function* () {
    let current = draft;
    for (const ext of extensionsFor(workspaceById(draft.workspace))) {
      for (const handler of ext.changeCreating) {
        const patch = yield* asWorkspaceById(draft.workspace, handler(current), ext.name).pipe(
          Effect.mapError(veto),
        );
        if (patch) current = { ...current, ...definedOnly(patch) };
      }
    }
    return current;
  });

/** Run every before-hook for an operation that has no draft to patch (completing, cancelling),
 * in extension load order, as the change's workspace with the extension's name bound. The first
 * failure vetoes: the operation must not start. */
export const beforeChange = (
  event: "change:completing" | "change:cancelling",
  change: Change,
): Effect.Effect<void, IweError> =>
  Effect.gen(function* () {
    for (const ext of extensionsFor(workspaceOf(change))) {
      for (const handler of beforeHooksFor(ext, event)) {
        yield* asWorkspace(change, handler(change), ext.name).pipe(Effect.mapError(veto));
      }
    }
  });

export type ProvisionResult = { integration: string; ok: boolean; error?: string };

/**
 * Run every after-hook for a committed change, in extension load order. Failures are collected
 * rather than thrown: the change already exists, and a half-provisioned change is fixable from
 * the dashboard once you can see what went wrong. A hook that failed stops its own extension's
 * later hooks — they would build on a half-done job — but never the extensions after it.
 */
const runAfter = (
  event: "change:created" | "change:completed" | "change:cancelled",
  change: Change,
): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    const results: ProvisionResult[] = [];
    for (const ext of extensionsFor(workspaceOf(change))) {
      for (const handler of afterHooksFor(ext, event)) {
        const outcome = yield* asWorkspace(change, handler(change), ext.name).pipe(
          Effect.map(() => ({ integration: ext.name, ok: true }) as ProvisionResult),
          Effect.catchAll((e) => Effect.succeed({ integration: ext.name, ok: false, error: messageOf(e) })),
        );
        results.push(outcome);
        if (!outcome.ok) break;
      }
    }
    return results;
  });

/** Run the `change:created` hooks for a freshly created change. */
export const provision = (change: Change): Effect.Effect<ProvisionResult[]> =>
  runAfter("change:created", change);

/** Run the after-hooks for a completed or cancelled change: always after change.json is written
 * and the change is archived, and never able to fail the operation. The results are reported
 * under each extension's own name, exactly as provisioning reports them. */
export const afterChange = (
  event: "change:completed" | "change:cancelled",
  change: Change,
): Effect.Effect<ProvisionResult[]> => runAfter(event, change);

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
