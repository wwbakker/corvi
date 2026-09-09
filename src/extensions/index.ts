import { Effect, Either } from "effect";
import { isFinished, type Change, type CompletionStep, type Widget, type WidgetItem } from "../types.ts";
import type { Workspace } from "../config.ts";
import { workspaceById, workspaceOf, usesJira } from "../workspaces.ts";
import { runRoute } from "../effect/run.ts";
import { capabilitiesLayer } from "./services.ts";
import type {
  Card,
  Capabilities,
  CompletionStepContributor,
  DescriptionSection,
  ExtensionFactory,
  IweExtensionApi,
  RouteHandler,
  TitleSource,
  WizardStep,
} from "./api.ts";

/**
 * The extension host: loads the built-in extensions, keeps what each contributed, and answers
 * the core's one question — which extensions exist for this workspace — with a plain filtered
 * list. There are no singleton slots and no arbitration: contributions are additive, and
 * enablement is per request, read live from the config, which is why toggling an extension on
 * the settings page takes effect at once.
 *
 * Contributed handlers are Effects (src/extensions/api.ts). The host runs each one inside
 * `capabilitiesLayer(workspaceOf(change))` — the request's workspace plus the four services —
 * so an extension's requirements arrive through the R channel and nothing needs bridging:
 * no ambient store, no promise seam. Built-ins only, so far: the loader is this one static
 * list. When out-of-tree extensions arrive, the list becomes a discovery pass and nothing
 * else here changes.
 */

/** One extension, as loaded: its identity plus everything it contributed. */
export type LoadedExtension = {
  name: string;
  title: string;
  cards: Card[];
  wizardSteps: WizardStep[];
  titleSources: TitleSource[];
  descriptionSections: DescriptionSection[];
  completionSteps: CompletionStepContributor[];
  /** Handlers registered with `on("change:created")`, in registration order. */
  changeCreated: ((change: Change) => Effect.Effect<void, unknown, Capabilities>)[];
  /** `"GET /issues"` → handler, under `/api/ext/<name>/…`. */
  routes: Map<string, RouteHandler>;
};

const emptyRecord = (name: string, title: string): LoadedExtension => ({
  name,
  title,
  cards: [],
  wizardSteps: [],
  titleSources: [],
  descriptionSections: [],
  completionSteps: [],
  changeCreated: [],
  routes: new Map(),
});

/** Everything loaded, in registration order — which is the dashboard's card order and the
 * wizard's step order within a phase. The test suite prunes and refills this directly. */
export const loaded: LoadedExtension[] = [];

/** The loader primitive: run one extension's factory against a fresh record and keep it. */
export function loadExtension(name: string, title: string, factory: ExtensionFactory): LoadedExtension {
  const record = emptyRecord(name, title);
  const api: IweExtensionApi = {
    get name() {
      return record.name;
    },
    registerCard: (card) => record.cards.push(card),
    registerWizardStep: (step) => record.wizardSteps.push(step),
    registerTitleSource: (source) => record.titleSources.push(source),
    registerDescriptionSection: (section) => record.descriptionSections.push(section),
    registerCompletionStep: (step) => record.completionSteps.push(step),
    on: (event, handler) => {
      if (event === "change:created") record.changeCreated.push(handler);
    },
    route: (method, path, handler) => record.routes.set(`${method} ${path}`, handler),
  };
  factory(api);
  loaded.push(record);
  return record;
}

// The built-ins, in dashboard order: local changes, then CI, then the ticket cards. Each is a
// module whose default export is a factory taking the API — the same shape a future
// out-of-tree extension will have.
import gitExtension from "./git/index.ts";
import ciExtension from "./ci/index.ts";
import jiraExtension from "./jira/index.ts";
import githubIssuesExtension from "./github-issues/index.ts";

loadExtension("git", "Local changes", gitExtension);
loadExtension("ci", "CI", ciExtension);
loadExtension("jira", "Jira", jiraExtension);
loadExtension("github-issues", "GitHub issues", githubIssuesExtension);

/**
 * Which extensions exist for this workspace.
 *
 * A workspace that names none has all of them — which is what IWE was before extensions
 * existed, and what an unconfigured machine still gets. One legacy exception: a workspace
 * could already switch Jira off with its own `jira: false` flag, and that flag keeps meaning
 * something until Jira's settings move into its extension.
 */
export const extensionsFor = (workspace: Workspace): LoadedExtension[] => {
  const names = workspace.extensions;
  if (!names) return loaded.filter((e) => e.name !== "jira" || usesJira(workspace));
  const wanted = new Set(names);
  return loaded.filter((e) => wanted.has(e.name));
};

/** The cards a change's dashboard shows, with the extension each belongs to — the extension's
 * name is the card's identity on the routes. */
export const cardsFor = (change: Change): { name: string; card: Card }[] =>
  extensionsFor(workspaceOf(change)).flatMap((e) => e.cards.map((card) => ({ name: e.name, card })));

/** One card by the extension's name, across every loaded extension. A change's workspace
 * governs which cards are *listed*; a card addressed directly is looked up everywhere, as it
 * always was. */
export const cardByName = (name: string): Card | undefined =>
  loaded.find((e) => e.name === name)?.cards[0];

/** The wizard steps of a workspace, in presentation order: issue steps before the change
 * details, repository-aware steps after the repositories are picked. */
export type WizardStepInfo = WizardStep & { extension: string };

export const wizardStepsFor = (workspace: Workspace): WizardStepInfo[] => {
  const steps = extensionsFor(workspace).flatMap((e) =>
    e.wizardSteps.map((s) => ({ ...s, extension: e.name })),
  );
  return [...steps.filter((s) => s.phase === "issue"), ...steps.filter((s) => s.phase === "repos")];
};

export const titleSourcesFor = (workspace: Workspace): TitleSource[] =>
  extensionsFor(workspace).flatMap((e) => e.titleSources);

export const descriptionSectionsFor = (workspace: Workspace): DescriptionSection[] =>
  extensionsFor(workspace).flatMap((e) => e.descriptionSections);

export const completionStepsFor = (workspace: Workspace): CompletionStepContributor[] =>
  extensionsFor(workspace).flatMap((e) => e.completionSteps);

/** Run one contributed effect as the change's workspace: the capabilities layer provides the
 * Workspace tag, Shell, Cache, Settings and Bus, and the effect's requirements are satisfied
 * through the R channel — nothing here bridges across a promise seam, because there is none. */
const asWorkspace = <A, E>(
  change: Change,
  effect: Effect.Effect<A, E, Capabilities>,
): Effect.Effect<A, E> => Effect.provide(effect, capabilitiesLayer(workspaceOf(change)));

/** A failure's message, the way every surface's error handling reports it. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

/** The extension routes as one dispatcher for the server's route table: `/api/ext/<name>/<path>`,
 * run as the workspace the request names, failures mapped to status codes by the same
 * `runRoute` the core's routes go through. Unknown routes answer undefined, which the server
 * turns into its 404. */
export const dispatchExtensionRoute = (req: Request): Promise<Response> | undefined => {
  const url = new URL(req.url);
  const match = /^\/api\/ext\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return undefined;
  const ext = loaded.find((e) => e.name === match[1]);
  const handler = ext?.routes.get(`${req.method} /${match[2]}`);
  if (!handler) return undefined;
  const route = handler(req).pipe(
    Effect.provide(capabilitiesLayer(workspaceById(url.searchParams.get("workspace") ?? undefined))),
  );
  return runRoute(route);
};

/** Re-exported for the contributors' convenience; the type lives in types.ts with the rest of
 * the dashboard's vocabulary. */
export type { CompletionStep };
