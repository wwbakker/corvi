import type { Change, CompletionStep, Integration } from "../types.ts";
import type { Workspace } from "../config.ts";

/**
 * The surface an extension can contribute to.
 *
 * An extension is a TypeScript module with a default-exported factory receiving this API — the
 * same shape pi's extensions have. It contributes to registries (cards, wizard steps, hooks) and
 * the host wires it up; it never mutates host state directly, and nothing here is named after a
 * vendor: an extension hooks the "Create change" screen, not "the task board".
 *
 * Everything is additive: any number of extensions may contribute to any surface, and the
 * per-workspace enablement (the `extensions` list in the workspace config) decides whose
 * contributions exist for the request in hand. There are no singleton slots to arbitrate.
 *
 * This file is the whole API on purpose: when out-of-tree extensions arrive, this is what they
 * get, and nothing else is a promise. Until then the built-in extensions live in-tree and may
 * import host internals (config, cache, sh, the integration implementations) directly — that
 * privilege goes away with dynamic loading, so new code should keep it to a minimum.
 */

/**
 * One step of the "Create change" wizard, as the server declares it.
 *
 * Steps run in phases: `issue` steps come before the change details (they prefill the id and
 * branch), `repos` steps come after the repositories are picked (they need the repositories to
 * look at). Within a phase, registration order. The step's *content* is the extension's client
 * component; this declaration is what the page is told exists.
 */
export type WizardStep = {
  /** Namespaced by the extension, so `id` doubles as the payload key on the change record. */
  id: string;
  /** What the step's tab in the wizard says. */
  title: string;
  phase: "issue" | "repos";
};

/**
 * What an extension is told when it is asked for its card, titles, description section or
 * completion step. The workspace is the change's own — the same one the request ran as, so
 * subprocesses already carry its environment; this is here for the few reads that want the
 * config object itself.
 */
export type ChangeContext = { workspace: Workspace };

/**
 * Names the changes it can title, and answers with summaries.
 *
 * A source that cannot answer (the vendor is down, the ticket is gone) contributes nothing for
 * that call: stored titles stand, which is the behaviour the overview has always had. Asked once
 * per workspace, with that workspace's claimed changes, inside that workspace's context.
 */
export type TitleSource = {
  /** Which of these changes are this source's to name. Changes whose title was written by hand
   * are filtered out before this is asked. */
  applies(change: Change): boolean;
  /** Summaries, keyed by change id — not by ticket key, which is the source's own business. */
  lookup(changes: Change[], ctx: ChangeContext): Promise<Map<string, string>>;
};

/**
 * A part of the pull-request description. Heading parts are joined with " - " into the first
 * line (the ticket and what it is); a section that has nothing to say returns undefined and is
 * simply absent.
 */
export type DescriptionSection = {
  heading(change: Change, ctx: ChangeContext): Promise<string | undefined>;
};

/**
 * One step of completing a change, contributed alongside the core's own (merge the pull
 * requests, remove the worktrees, archive). Contributed steps run after the merges and before
 * the worktrees go, in registration order, and are journaled like every other step: the plan is
 * named before anything runs, and the outcome is written as it happens.
 */
export type CompletionStepContributor = {
  /** The step as the plan shows it while waiting, or undefined when this change has nothing
   * for it to do (no issue linked, say) — in which case `run` is not called either. */
  plan(change: Change, ctx: ChangeContext): CompletionStep | undefined;
  /** Do it. A returned string is recorded as the step's detail; a throw fails the completion
   * where it stands, exactly as a core step's failure does. */
  run(change: Change, ctx: ChangeContext): Promise<string | void>;
};

/** A route handler under `/api/ext/<extension>/…`. Runs as the workspace named by the request's
 * `?workspace=` parameter, so its subprocesses carry that workspace's environment. */
export type RouteHandler = (req: Request) => Promise<Response>;

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type IweExtensionApi = {
  /** The extension's name, as it was loaded. Also the key of its entry in a change's
   * `extensions` bag and the prefix of its routes. */
  readonly name: string;

  /** A dashboard card — the same `Integration` shape the built-in components have always had:
   * a whole-widget `status`, an optional per-repository `repoStatus`, optional actions. */
  registerCard(card: Integration): void;

  /** A step in the "Create change" wizard. The step's UI is the extension's client component
   * (see docs/extensions.md); this declares that the step exists. */
  registerWizardStep(step: WizardStep): void;

  /** Called when a change was created and its worktrees are in place — assign a ticket, move it
   * to "In Progress". The result is reported to the wizard under the extension's name; a throw
   * is one extension's failure, never a failed change. */
  on(event: "change:created", handler: (change: Change, ctx: ChangeContext) => Promise<void>): void;

  registerTitleSource(source: TitleSource): void;
  registerDescriptionSection(section: DescriptionSection): void;
  registerCompletionStep(step: CompletionStepContributor): void;

  /** A route under `/api/ext/<name>/…` — single-segment paths, e.g. route("GET", "/issues", …). */
  route(method: RequestMethod, path: string, handler: RouteHandler): void;
};

/** What an extension module default-exports: a factory taking the API, pi-style. */
export type ExtensionFactory = (api: IweExtensionApi) => void;
