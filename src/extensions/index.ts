import { Effect, Either, Option } from "effect";
import { isFinished, type Change, type CompletionStep, type Integration, type WidgetItem, type Widget } from "../types.ts";
import type { Workspace } from "../config.ts";
import { workspaceById, workspaceOf, usesJira } from "../workspaces.ts";
import { provideWorkspace } from "../context.ts";
import { workspaceOption } from "../effect/tags.ts";
import type {
  ChangeContext,
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
 * Built-ins only, so far: the loader is this one static list. When out-of-tree extensions
 * arrive, the list becomes a discovery pass and nothing else here changes.
 */

/** One extension, as loaded: its identity plus everything it contributed. */
export type LoadedExtension = {
  name: string;
  title: string;
  cards: Integration[];
  wizardSteps: WizardStep[];
  titleSources: TitleSource[];
  descriptionSections: DescriptionSection[];
  completionSteps: CompletionStepContributor[];
  /** Handlers registered with `on("change:created")`, in registration order. */
  changeCreated: ((change: Change, ctx: ChangeContext) => Promise<void>)[];
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
// module whose default export is a factory taking the API — the same shape a future out-of-tree
// extension will have.
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
 * A workspace that names none has all of them — which is what IWE was before extensions existed,
 * and what an unconfigured machine still gets. One legacy exception: a workspace could already
 * switch Jira off with its own `jira: false` flag, and that flag keeps meaning something until
 * Jira's settings move into its extension.
 */
export const extensionsFor = (workspace: Workspace): LoadedExtension[] => {
  const names = workspace.extensions;
  if (!names) return loaded.filter((e) => e.name !== "jira" || usesJira(workspace));
  const wanted = new Set(names);
  return loaded.filter((e) => wanted.has(e.name));
};

/** The cards a change's dashboard shows: the ones its workspace has at all. */
export const cardsFor = (change: Change): Integration[] =>
  extensionsFor(workspaceOf(change)).flatMap((e) => e.cards);

/** One card by name, across every loaded extension. A change's workspace governs which cards
 * are *listed*; a card addressed directly is looked up everywhere, as it always was. */
export const cardByName = (name: string): Integration | undefined => {
  for (const ext of loaded) {
    const card = ext.cards.find((c) => c.name === name);
    if (card) return card;
  }
  return undefined;
};

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

// ---------------------------------------------------------------------------
// Running extension code with the request's workspace attached.
// ---------------------------------------------------------------------------

/** The context handed to hooks: the workspace this request runs as. Outside a request — a test,
 * a startup call — the change's own workspace stands in. */
const contextFor = (change: Change, ws: Workspace | undefined): ChangeContext => ({
  workspace: ws ?? workspaceOf(change),
});

/** Run one Promise-shaped piece of extension code inside the request's workspace: every
 * subprocess it starts, however deep, carries the workspace's environment. This is the same
 * bridge the cards have always used — their methods are Promises so tests can stub them, and
 * the workspace reaches them through the ambient store. */
export const bridged = <A>(work: (ws: Workspace | undefined) => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.flatMap(workspaceOption, (ws) =>
    Effect.tryPromise({
      try: () => {
        const run = () => work(Option.getOrUndefined(ws));
        return Option.isSome(ws) ? provideWorkspace(ws.value, run) : run();
      },
      catch: (e) => e,
    }));

/** A change-scoped bridge: the same, with the `ChangeContext` the hooks take. */
const bridgedFor = <A>(
  change: Change,
  work: (ctx: ChangeContext) => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.flatMap(workspaceOption, (ws) =>
    Effect.tryPromise({
      try: () => {
        const ctx = contextFor(change, Option.getOrUndefined(ws));
        const run = () => work(ctx);
        return Option.isSome(ws) ? provideWorkspace(ctx.workspace, run) : run();
      },
      catch: (e) => e,
    }));

export type ProvisionResult = { integration: string; ok: boolean; error?: string };

/**
 * Run every `change:created` hook for a freshly created change. Failures are collected rather
 * than thrown: the change already exists, and a half-provisioned change is fixable from the
 * dashboard once you can see what went wrong.
 */
export const provisionEffect = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    const results: ProvisionResult[] = [];
    for (const ext of extensionsFor(workspaceOf(change))) {
      for (const handler of ext.changeCreated) {
        const outcome = yield* bridgedFor(change, (ctx) => handler(change, ctx)).pipe(
          Effect.map(() => ({ integration: ext.name, ok: true }) as ProvisionResult),
          Effect.catchAll((e) =>
            Effect.succeed({
              integration: ext.name,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            })),
        );
        results.push(outcome);
        // A hook that failed may have left its extension half-done, and its later hooks would
        // build on that. Stop this extension, keep going with the others.
        if (!outcome.ok) break;
      }
    }
    return results;
  });

/** Promise facade over provisionEffect, in the old signature. Kept for the test suite. */
export const provision = (change: Change): Promise<ProvisionResult[]> =>
  Effect.runPromise(provisionEffect(change));

/** One card's widget; a thrown error becomes a red card rather than a failed request. */
export const statusOneEffect = (card: Integration, change: Change): Effect.Effect<Widget> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      Effect.gen(function* () {
        if (!card.status) {
          return yield* Effect.fail(new Error(`${card.name} reports per repository`));
        }
        const widget: Widget = yield* bridged(() => card.status!(change));
        return isFinished(change) ? { ...widget, items: readOnly(widget.items) } : widget;
      }),
    );
    if (Either.isLeft(found)) {
      const e = found.left;
      return {
        integration: card.name,
        title: card.title,
        state: "error",
        summary: e instanceof Error ? e.message : String(e),
        items: [],
      };
    }
    return found.right;
  });

/** One repository's rows, for the cards that report per repository. A failure becomes a red row
 * for that repository only: the others keep loading. */
export const repoStatusOfEffect = (
  card: Integration,
  change: Change,
  repo: string,
): Effect.Effect<WidgetItem[]> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      Effect.gen(function* () {
        if (!card.repoStatus) {
          return yield* Effect.fail(new Error(`${card.name} has no per-repository view`));
        }
        const items: WidgetItem[] = yield* bridged(() => card.repoStatus!(change, repo));
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

/** Promise facade over repoStatusOfEffect, in the old signature. Kept for the test suite. */
export const repoStatusOf = (
  card: Integration,
  change: Change,
  repo: string,
): Promise<WidgetItem[]> => Effect.runPromise(repoStatusOfEffect(card, change, repo));

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
 * run as the workspace the request names. Unknown routes answer undefined, which the server
 * turns into its 404. */
export const dispatchExtensionRoute = (req: Request): Promise<Response> | undefined => {
  const url = new URL(req.url);
  const match = /^\/api\/ext\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return undefined;
  const ext = loaded.find((e) => e.name === match[1]);
  const handler = ext?.routes.get(`${req.method} /${match[2]}`);
  if (!handler) return undefined;
  return provideWorkspace(workspaceById(url.searchParams.get("workspace") ?? undefined), () =>
    handler(req));
};

/** Re-exported for the contributors' convenience; the type lives in types.ts with the rest of
 * the dashboard's vocabulary. */
export type { CompletionStep };
