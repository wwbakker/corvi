import { Effect, Either, Option } from "effect";
import { isFinished, type Change, type Integration, type Widget, type WidgetItem } from "../types.ts";
import { applies } from "../workspaces.ts";
import type { Workspace } from "../config.ts";
import { provideWorkspace } from "../context.ts";
import { workspaceOption } from "../effect/tags.ts";
import { git } from "./git.ts";
import { jira } from "./jira.ts";
import { ci } from "./ci.ts";

/** The whole "component system": a lookup table. Add an entry to add a component. */
/** Insertion order is dashboard order: the ticket first, then local work, then CI. */
export const integrations: Record<string, Integration> = {
  [jira.name]: jira,
  [git.name]: git,
  [ci.name]: ci,
};

export type ProvisionResult = { integration: string; ok: boolean; error?: string };

/** The components a change's dashboard shows: the ones its workspace has at all. */
// Pure and synchronous: nothing for an Effect to wrap.
export const integrationsFor = (change: Change) =>
  Object.values(integrations).filter((i) => applies(i.name, change));

/** Call one of the Integration object's Promise methods from Effect, carrying the request's
 * workspace across: the Integration interface keeps Promise methods (the test suites stub them
 * with plain async functions), so each method's own Effect runs in a detached runtime the
 * Workspace tag cannot reach. This is the one bridge that keeps the ambient store alive. */
export const bridged = <A>(work: (ws: Workspace | undefined) => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.flatMap(workspaceOption, (ws) =>
    Effect.tryPromise({
      try: () => {
        const run = () => work(Option.getOrUndefined(ws));
        return Option.isSome(ws) ? provideWorkspace(ws.value, run) : run();
      },
      catch: (e) => e,
    }));

/** Run every integration's provisioning step for a freshly created change. Failures are
 * collected rather than thrown: the change already exists, and a half-provisioned change is
 * fixable from the dashboard once you can see what went wrong. */
export const provisionEffect = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    const results: ProvisionResult[] = [];
    for (const i of Object.values(integrations)) {
      // A context without Jira has no ticket to move: provisioning it would be an error about a
      // thing this change was never going to have.
      if (!i.provision || !applies(i.name, change)) continue;
      results.push(
        yield* bridged(() => i.provision!(change)).pipe(
          Effect.map(() => ({ integration: i.name, ok: true })),
          Effect.catchAll((e) =>
            Effect.succeed({
              integration: i.name,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            })),
        ),
      );
    }
    return results;
  });

// The Integration interface keeps its Promise methods on purpose: the test suites stub them
// with plain async functions, and the tests must pass unmodified. `bridged` above is the seam
// every call site goes through.

/** Promise facade over provisionEffect, in the old signature. Kept for the test suite, which
 * must pass unmodified. */
export const provision = (change: Change): Promise<ProvisionResult[]> =>
  Effect.runPromise(provisionEffect(change));

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

// Pure and synchronous: nothing for an Effect to wrap.

/** One integration's widget; a thrown error becomes a red card rather than a failed request. */
export const statusOneEffect = (integration: Integration, change: Change): Effect.Effect<Widget> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      Effect.gen(function* () {
        if (!integration.status) {
          return yield* Effect.fail(new Error(`${integration.name} reports per repository`));
        }
        const widget: Widget = yield* bridged(() => integration.status!(change));
        return isFinished(change) ? { ...widget, items: readOnly(widget.items) } : widget;
      }),
    );
    if (Either.isLeft(found)) {
      const e = found.left;
      return {
        integration: integration.name,
        title: integration.title,
        state: "error",
        summary: e instanceof Error ? e.message : String(e),
        items: [],
      };
    }
    return found.right;
  });

/** One repository's rows, for the components that report per repository. A failure becomes a
 * red row for that repository only: the others keep loading. */
export const repoStatusOfEffect = (
  integration: Integration,
  change: Change,
  repo: string,
): Effect.Effect<WidgetItem[]> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      Effect.gen(function* () {
        if (!integration.repoStatus) {
          return yield* Effect.fail(new Error(`${integration.name} has no per-repository view`));
        }
        const items: WidgetItem[] = yield* bridged(() => integration.repoStatus!(change, repo));
        return isFinished(change) ? readOnly(items) : items;
      }),
    );
    if (Either.isLeft(found)) {
      const e = found.left;
      return [
        {
          label: repo.split("/").pop() ?? repo,
          detail: e instanceof Error ? e.message : String(e),
          state: "error",
        },
      ];
    }
    return found.right;
  });

/** Promise facade over repoStatusOfEffect, in the old signature. Kept for the test suite,
 * which must pass unmodified. */
export const repoStatusOf = (
  integration: Integration,
  change: Change,
  repo: string,
): Promise<WidgetItem[]> => Effect.runPromise(repoStatusOfEffect(integration, change, repo));
