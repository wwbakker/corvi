import { Effect, Either, Layer } from "effect";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isFinished, type Change, type CompletionStep, type Widget, type WidgetItem } from "../types.ts";
import { config, expandTilde, type Workspace } from "../config.ts";
import { workspaceById, workspaceOf } from "../workspaces.ts";
import { runRoute } from "../effect/run.ts";
import { capabilitiesLayer } from "./services.ts";
import type {
  Card,
  Capabilities,
  CompletionStepContributor,
  DescriptionSection,
  Extension,
  ExtensionModule,
  RouteHandler,
  TitleSource,
  WizardStep,
  WorkspaceSetting,
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
 * no ambient store, no promise seam. The built-ins are joined, after them, by out-of-tree
 * extensions discovered from the config and imported from disk — through the same
 * install/factory path, so the contract (docs/extensions.md) does not change with the
 * extension's address.
 */

/** One extension, as loaded: its description, normalized — the arrays coalesced to empty and
 * the lifecycle handlers pulled out of the events map, so the host's loops stay flat. */
export type LoadedExtension = {
  name: string;
  title: string;
  cards: Card[];
  wizardSteps: WizardStep[];
  titleSources: TitleSource[];
  descriptionSections: DescriptionSection[];
  completionSteps: CompletionStepContributor[];
  /** Handlers declared under `events["change:created"]`, in declaration order. */
  changeCreated: ((change: Change) => Effect.Effect<void, unknown, Capabilities>)[];
  /** The routes as a lookup: `"GET /issues"` → handler, under `/api/ext/<name>/…`. */
  routeTable: Map<string, RouteHandler>;
  /** Per-workspace settings the extension declares, for the settings page to render. */
  workspaceSettings: WorkspaceSetting[];
  /** Host-internal, out-of-tree extensions only: the sibling client.tsx of the discovered
   * module, which the server builds into a chunk the page imports at runtime
   * (/extensions/<name>/client.js — src/extensions/clientChunks.ts). Built-ins are bundled
   * into the page instead and never carry one. */
  clientPath?: string;
};

const normalize = (ext: Extension, clientPath?: string): LoadedExtension => ({
  name: ext.name,
  title: ext.title,
  workspaceSettings: ext.workspaceSettings ?? [],
  cards: ext.cards ?? [],
  wizardSteps: ext.wizardSteps ?? [],
  titleSources: ext.titleSources ?? [],
  descriptionSections: ext.descriptionSections ?? [],
  completionSteps: ext.completionSteps ?? [],
  changeCreated: ext.events?.["change:created"] ?? [],
  routeTable: new Map((ext.routes ?? []).map((r) => [`${r.method} ${r.path}`, r.handler])),
  ...(clientPath ? { clientPath } : {}),
});

/** Everything loaded, in load order — which is the dashboard's card order and the wizard's
 * step order within a phase. The test suite prunes and refills this directly. */
export const loaded: LoadedExtension[] = [];

/** Install a static description, rejecting duplicates: a second extension under a used name
 * is skipped with a word, and the original wins. The test suite installs stubs with this. */
export function install(ext: Extension, clientPath?: string): LoadedExtension {
  if (!ext.name) {
    console.error(`an extension without a name is skipped`);
    return normalize({ ...ext, name: "" }, clientPath);
  }
  const clash = loaded.find((e) => e.name === ext.name);
  if (clash) {
    console.error(`two extensions are called "${ext.name}" — the second one is skipped`);
    return clash;
  }
  const record = normalize(ext, clientPath);
  loaded.push(record);
  return record;
}

/** Install one module: a static description as-is, a factory run once with the startup
 * capabilities. A failed factory is an extension absent, with the error logged — a broken
 * optional plugin does not take the dashboard down. Shared by the built-ins and the
 * out-of-tree discovery, so the two load exactly alike. */
async function installModule(mod: ExtensionModule, clientPath?: string): Promise<void> {
  if (typeof mod !== "function") {
    install(mod, clientPath);
    return;
  }
  try {
    const ext = await Effect.runPromise(
      mod().pipe(
        // The default workspace stands in for the request's: there is no request at startup,
        // and load-time Shell runs with its environment (docs/extensions.md).
        Effect.provide(capabilitiesLayer(workspaceById(undefined))),
      ),
    );
    install(ext, clientPath);
  } catch (e) {
    console.error(
      `an extension failed to load and is skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Load every module, in order. A failed factory is an extension absent, with the error
 * logged — a broken optional plugin does not take the dashboard down.
 *
 * Awaited at module scope, so the server does not start listening before the extensions have
 * loaded, and a test importing this file sees the fully-loaded registry. */
export async function loadAll(mods: readonly ExtensionModule[]): Promise<void> {
  for (const mod of mods) await installModule(mod);
}

// The built-ins, in dashboard order: local changes, then CI, then the ticket cards. Each is a
// module whose default export describes it — a static value, or a factory for one.
import gitExtension from "./git/index.ts";
import ciExtension from "./ci/index.ts";
import jiraExtension from "./jira/index.ts";
import githubIssuesExtension from "./github-issues/index.ts";

/** The directory searched for out-of-tree extensions without being configured: it exists on a
 * machine that keeps extensions there, and is absent everywhere else — a convention, not a
 * setting, so it never appears in the config file the settings page edits. */
export const defaultExtensionDir = (): string =>
  join(homedir(), ".config", "iwe", "extensions");

/** Expand the configured extension paths into module files. A path that is a file is the
 * module; a directory contributes its immediate .ts files plus any subdirectory's index.ts, in directory
 * order. A path that does not exist is logged and skipped — one broken entry costs nothing.
 * Duplicates are ignored, first mention wins. Defaults to the configured paths plus the
 * implicit default directory, searched last — silently: its absence is the ordinary case,
 * not something to log. */
export function extensionModulePaths(
  paths: readonly string[] = [
    ...config.extensionPaths,
    ...(existsSync(defaultExtensionDir()) ? [defaultExtensionDir()] : []),
  ],
): string[] {
  const seen = new Set<string>();
  const modules: string[] = [];
  for (const raw of paths) {
    const path = expandTilde(raw);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      console.error(`extension path does not exist, skipped: ${path}`);
      continue;
    }
    const found: string[] = [];
    if (stat.isFile()) {
      found.push(path);
    } else if (stat.isDirectory()) {
      const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          found.push(join(path, entry.name));
        } else if (entry.isDirectory() && existsSync(join(path, entry.name, "index.ts"))) {
          found.push(join(path, entry.name, "index.ts"));
        }
      }
    } else {
      console.error(`extension path is neither a file nor a directory, skipped: ${path}`);
    }
    for (const module of found) {
      if (!seen.has(module)) {
        seen.add(module);
        modules.push(module);
      }
    }
  }
  return modules;
}

/** The sibling client.tsx of a discovered module file, when it exists — the half the server
 * builds into a chunk for the page (src/extensions/clientChunks.ts). */
const siblingClient = (modulePath: string): string | undefined => {
  const client = join(dirname(modulePath), "client.tsx");
  return existsSync(client) ? client : undefined;
};

/** Load the out-of-tree extensions: import each discovered module from disk and run it
 * through the same install/factory path as the built-ins. Every failure — a missing file, a
 * module that throws on import, one without a default export, a failed factory — is logged
 * and skipped: a broken optional extension is an extension absent, never a failed server. */
export async function loadDiscovered(paths?: readonly string[]): Promise<void> {
  for (const modulePath of extensionModulePaths(paths)) {
    try {
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        default?: ExtensionModule;
      };
      if (!mod.default) {
        console.error(`an extension module without a default export is skipped: ${modulePath}`);
        continue;
      }
      await installModule(mod.default, siblingClient(modulePath));
    } catch (e) {
      console.error(
        `an extension failed to load and is skipped: ${modulePath}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

await loadAll([gitExtension, ciExtension, jiraExtension, githubIssuesExtension]);
// Out-of-tree, after the built-ins: the configured paths, then the implicit default directory,
// discovered and imported from disk through the same install path as the above.
await loadDiscovered();

/**
 * Normalize the workspaces' extension settings against what is loaded, in place.
 *
 * Two legacy shapes are folded into the one key extensions read today:
 *
 * - a workspace still configuring Jira through its own `jira` object has those fields copied
 *   into `extensionSettings.jira`, where the jira extension's declaration puts and reads them;
 * - a workspace still switching Jira off with `jira: false` and naming no extensions gets an
 *   explicit list — everything loaded except jira — because naming some is the whole list, and
 *   a list you can read is worth more than a flag nothing reads anymore.
 *
 * A workspace with an explicit `extensions` list is otherwise never touched. Everything else is
 * left exactly as it was. Run after the built-ins load (below) and after every settings write
 * (src/settings.ts), so both hand-edits and page writes land normalized.
 */
export function migrateWorkspaceSettings(workspaces: Workspace[]): Workspace[] {
  for (const workspace of workspaces) {
    if (workspace.jira && !workspace.extensionSettings?.jira) {
      const { project, board, configFile, tokenEnv } = workspace.jira;
      workspace.extensionSettings = {
        ...workspace.extensionSettings,
        jira: {
          ...(project !== undefined && { project }),
          ...(board !== undefined && { board }),
          ...(configFile !== undefined && { configFile }),
          ...(tokenEnv !== undefined && { tokenEnv }),
        },
      };
    } else if (workspace.jira === false && !workspace.extensions) {
      workspace.extensions = loaded.map((e) => e.name).filter((name) => name !== "jira");
    }
  }
  return workspaces;
}

migrateWorkspaceSettings(config.workspaces);

/**
 * Which extensions exist for this workspace.
 *
 * A workspace that names none has all of them — which is what IWE was before extensions
 * existed, and what an unconfigured machine still gets. The legacy `jira: false` flag is gone:
 * migrateWorkspaceSettings turns it into an explicit extensions list on load, so there is
 * nothing left to special-case here.
 */
export const extensionsFor = (workspace: Workspace): LoadedExtension[] => {
  const names = workspace.extensions;
  if (!names) return loaded;
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
  const handler = ext?.routeTable.get(`${req.method} /${match[2]}`);
  if (!handler) return undefined;
  const route = handler(req).pipe(
    Effect.provide(capabilitiesLayer(workspaceById(url.searchParams.get("workspace") ?? undefined))),
  );
  return runRoute(route);
};

/** Re-exported for the contributors' convenience; the type lives in types.ts with the rest of
 * the dashboard's vocabulary. */
export type { CompletionStep };
