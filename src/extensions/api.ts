import { Context, Effect } from "effect";
import type { CliError } from "../effect/errors.ts";
import type { Change, CompletionStep, Widget, WidgetItem } from "../types.ts";
import type { Config, Workspace as WorkspaceConfig } from "../config.ts";
import { Workspace as WorkspaceTag } from "../effect/tags.ts";

/**
 * The surface an extension can contribute to — Effect edition.
 *
 * An extension is a TypeScript module with a default-exported factory receiving this API — the
 * same shape pi's extensions have. It contributes to registries (cards, wizard steps, hooks)
 * and the host wires it up; it never mutates host state directly, and nothing here is named
 * after a vendor: an extension hooks the "Create change" screen, not "the task board".
 *
 * Everything is additive: any number of extensions may contribute to any surface, and the
 * per-workspace enablement (the `extensions` list in the workspace config) decides whose
 * contributions exist for the request in hand. There are no singleton slots to arbitrate.
 *
 * Handlers are Effects, and that is the dependency-injection contract:
 *
 * - **The host provides `Capabilities`** — the Workspace tag (the request's own), a `Shell`
 *   for subprocesses with the workspace's environment, the answer `Cache`, the `Settings`,
 *   and the event `Bus`. An effect may require any subset; requiring anything outside the
 *   union fails to typecheck, which is what makes "no host imports" checkable rather than a
 *   matter of discipline.
 * - **Failures are values in the E channel.** On the capability surfaces the host handles any
 *   failure by its message (a failed card is a red card, a failed lookup contributes
 *   nothing), so those channels are `unknown` — fail with whatever typed error you like.
 *   Routes are the exception: their failures map to HTTP status codes, so they are typed as
 *   the taxonomy (`RouteError`), exactly like the core's own routes.
 * - **Pure functions stay pure.** `applies` and `plan` are synchronous and receive plain
 *   data; no effect wrapper buys anything there, and the completion plan must be answerable
 *   before anything runs anyway.
 *
 * This file is the whole API on purpose: when out-of-tree extensions arrive, this is what
 * they get, and nothing else is a promise.
 */

// --- Capabilities: what the host provides to every contributed effect ---------------------

/** The request's workspace — the same tag the core's routes provide (src/effect/tags.ts).
 * Re-exported so this file stays the one import an extension needs. */
export { WorkspaceTag as Workspace };

/** One CLI call's outcome: exit codes are data — callers branch on `code`; the typed failure
 * is reserved for a timeout, which kills the child (src/sh.ts). */
export type { Result } from "../sh.ts";

/** Run a subprocess with the request workspace's environment already applied
 * (`GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_API_TOKEN`, …), through the shared semaphore
 * and the CLI timeout. `run` requires `Workspace` because the environment comes from it:
 * the host provides the tag alongside the service, so requiring both is free. */
export class Shell extends Context.Tag("iwe/Shell")<Shell, {
  run(cmd: readonly string[], opts?: { cwd?: string }): Effect.Effect<
    { code: number; stdout: string; stderr: string },
    CliError,
    WorkspaceTag
  >;
}>() {}

/** The answer cache: read-through with a TTL, one shared refresh per key, and prefix
 * invalidation for when an action has just made an answer wrong. The work's requirements
 * pass through untouched — the cache stores outcomes, not contexts. */
export class Cache extends Context.Tag("iwe/Cache")<Cache, {
  swr<A, E, R>(key: string, ttlMs: number, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  invalidate(prefix: string): Effect.Effect<void>;
}>() {}

/** The settings in effect — the same refilled object every module holds, so a settings-page
 * save is visible without restart. Read-only by convention. */
export class Settings extends Context.Tag("iwe/Settings")<Settings, Config>() {}

/** Say something changed, so open pages refetch through the event stream. */
export class Bus extends Context.Tag("iwe/Bus")<Bus, {
  announce(event: "changes" | "windows"): Effect.Effect<void>;
}>() {}

/** The union the host provides. An effect may require any subset — requiring less is
 * assignable to requiring the union, so handlers declare only what they use. */
export type Capabilities = WorkspaceTag | Shell | Cache | Settings | Bus;

// --- Routes get the real prize of typed errors: the host maps them to status codes --------

export {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  NotFoundError,
} from "../effect/errors.ts";
export type RouteError = import("../effect/errors.ts").IweError;

// --- Surfaces -----------------------------------------------------------------------------

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

/** One step of the "Create change" wizard, as the server declares it. Steps run in phases:
 * `issue` steps come before the change details (they prefill the id and branch), `repos`
 * steps come after the repositories are picked (they need the repositories to look at).
 * Within a phase, registration order. The step's *content* is the extension's client
 * component; this declaration is what the page is told exists. */
export type WizardStep = {
  /** Namespaced by the extension: it doubles as the payload key on the change record. */
  id: string;
  /** What the step's tab in the wizard says. */
  title: string;
  phase: "issue" | "repos";
};

/** Names the changes it can title, and answers with summaries. A failed lookup contributes
 * nothing — stored titles stand, which is the behaviour the overview has always had. Asked
 * once per workspace, with that workspace's claimed changes. */
export type TitleSource = {
  /** Pure: which of these changes are this source's to name. Changes whose title was
   * written by hand are filtered out before this is asked. */
  applies(change: Change): boolean;
  /** Summaries, keyed by change id — not by ticket key, which is the source's own business. */
  lookup(changes: Change[]): Effect.Effect<Map<string, string>, unknown, Capabilities>;
};

/** A part of the pull-request description. Heading parts are joined with " - " into the
 * first line; a section that has nothing to say returns undefined and is simply absent. */
export type DescriptionSection = {
  heading(change: Change): Effect.Effect<string | undefined, unknown, Capabilities>;
};

/** What a pure completion-plan function is handed, since it runs before anything does: the
 * plain data it may name a step from. Pure functions get plain data, not services. */
export type PlanWorld = { config: Config; workspace: WorkspaceConfig };

/** One step of completing a change, contributed alongside the core's own (merge the pull
 * requests, remove the worktrees, archive). Contributed steps run after the merges and
 * before the worktrees go, in registration order, and are journaled like every other step:
 * the plan is named before anything runs, and the outcome is written as it happens. */
export type CompletionStepContributor = {
  /** The step as the plan shows it while waiting, or undefined when this change has nothing
   * for it to do (no issue linked, say) — in which case `run` is not called either. */
  plan(change: Change, world: PlanWorld): CompletionStep | undefined;
  /** Do it. A returned string is recorded as the step's detail; a failure stops the
   * completion where it stands, exactly as a core step's failure does. */
  run(change: Change): Effect.Effect<string | void, unknown, Capabilities>;
};

/** A route under `/api/ext/<extension>/…`, behind the same origin guard as the core's
 * routes, run as the workspace the request names. Failures map to HTTP status codes through
 * the same mapping the core's routes use — fail with the taxonomy and the status is right. */
export type RouteHandler = (req: Request) => Effect.Effect<Response, RouteError, Capabilities>;

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type IweExtensionApi = {
  /** The extension's name, as it was loaded. Also the key of its entry in a change's
   * `extensions` bag, its cards' identity on the routes, and the prefix of its routes. */
  readonly name: string;

  registerCard(card: Card): void;

  /** A step in the "Create change" wizard. The step's UI is the extension's client
   * component; this declares that the step exists. */
  registerWizardStep(step: WizardStep): void;

  /** Called when a change was created and its worktrees are in place — create the
   * worktrees, assign a ticket, move it to "In Progress". The result is reported to the
   * wizard under the extension's name; a failure is one extension's failure, never a
   * failed change, and the extensions after it still run. */
  on(
    event: "change:created",
    handler: (change: Change) => Effect.Effect<void, unknown, Capabilities>,
  ): void;

  registerTitleSource(source: TitleSource): void;
  registerDescriptionSection(section: DescriptionSection): void;
  registerCompletionStep(step: CompletionStepContributor): void;

  /** A route under `/api/ext/<name>/…` — single-segment paths, e.g. route("GET", "/issues", …). */
  route(method: RequestMethod, path: string, handler: RouteHandler): void;
};

/** What an extension module default-exports: a factory taking the API, pi-style. */
export type ExtensionFactory = (api: IweExtensionApi) => void;
