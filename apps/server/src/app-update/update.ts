/**
 * Auto-update: the app updating itself from the checkout it runs from.
 *
 * The feature is for the installed app alone (its window spawns the server with `CORVI_APP_KIND`),
 * on the remote's default branch: a dev server, the browser fallback and a feature branch have no
 * business pulling under a running process or reinstalling an app some other checkout owns. What
 * is new is checked on its own cadence — at startup and every two hours — and read from the last
 * check; the update itself runs the plan below, journaled step by step on the shared
 * operation-progress shape (apps/server/src/app-update/journal.ts) so a run that stops half way
 * says where it stopped and picks up from there on "Try again".
 *
 * The mutating steps run as themselves — `git pull --ff-only` through the repositories
 * capability (a fast-forward exactly, never a merge), and the two Bun commands through the app's
 * shell, which is also the seam a test scripts them at.
 */
import { Effect, Exit, Schema } from "effect";

import { AbsolutePath } from "@corvi/contracts/paths";
import type { CliError } from "@corvi/contracts/errors";
import {
  Repositories,
  type CheckoutError,
  type IncomingCommit,
  type NotARepository,
} from "@corvi/repositories";
import type {
  AppUpdateStatusDto,
  IncomingCommitDto,
  OperationProgressDto,
  OperationStepDto,
} from "@corvi/contracts/api";
import { shOrThrow } from "../capabilities/shell.ts";
import { commandAvailable } from "../capabilities/os.ts";
import { announce } from "../capabilities/bus.ts";
import { layer as repositoriesLayer } from "@corvi/repositories/node";
import { readJournal, writeJournal, type UpdateJournalError } from "./journal.ts";

/** Where the running app's checkout is, and whether this run is the installed app's own. Read
 * once at the composition root (apps/server/src/server.ts), never from inside an operation. */
export type AppUpdateOptions = {
  readonly root: string;
  readonly app: boolean;
};

/** The update is refused right now; `reason` is what the dialog shows in place of the button. */
export class UpdateRefused extends Schema.TaggedError<UpdateRefused>()("UpdateRefused", {
  reason: Schema.String,
}) {}

/** Another update is already running; a second one would race it for the tree and the journal. */
export class UpdateBusy extends Schema.TaggedError<UpdateBusy>()("UpdateBusy", {
  reason: Schema.String,
}) {}

/** When this process started: an update that finished before it cannot be one whose restart is
 * still pending — the journal keeps its record across restarts on purpose. */
const SERVER_STARTED_AT = Date.now();

/** The check's cadence, per the product decision: two hours. */
const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;

// The checker's dedup state: which tip was announced last, and when a check last ran. Owned by
// this module because there is one checker per server; a fresh server announces what it finds.
let announcedTip: string | undefined;
let lastChecked: string | undefined;
/** One run at a time, across requests: taken before anything reads or writes, and held until
 * the background run ends — whatever way it ends, its `ensuring` lets the next one in. */
let running = false;

const takeGuard = (): Effect.Effect<boolean> =>
  Effect.sync(() => {
    if (running) return false;
    running = true;
    return true;
  });

const releaseGuard = (): Effect.Effect<void> => Effect.sync(() => { running = false; });

/** The forge's web home for a remote URL — `github.com/owner/repo` in any spelling git accepts.
 * Undefined for anything else: the app links to commits and compares where it can prove the page
 * exists, and shows plain text rows elsewhere. */
// Pure and synchronous: nothing for an Effect to wrap.
export const webBase = (remoteUrl: string): string | undefined => {
  const cleaned = remoteUrl.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
  const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/](.+)$/.exec(cleaned);
  return match?.[1] ? `https://github.com/${match[1]}` : undefined;
};

/** The forge's page for one commit, when the remote lives at one that can be linked to. */
// Pure and synchronous: nothing for an Effect to wrap.
export const commitUrl = (remoteUrl: string | undefined, sha: string): string | undefined => {
  const base = remoteUrl === undefined ? undefined : webBase(remoteUrl);
  return base === undefined ? undefined : `${base}/commit/${sha}`;
};

/** The forge's compare page for a range, when the remote lives at one that can be linked to. */
// Pure and synchronous: nothing for an Effect to wrap.
export const comparePage = (
  remoteUrl: string | undefined,
  from: string,
  to: string,
): string | undefined => {
  const base = remoteUrl === undefined ? undefined : webBase(remoteUrl);
  return base === undefined ? undefined : `${base}/compare/${from}...${to}`;
};

/** The update plan, in the order it runs, as the journal shows it. */
const STEP_PLAN: readonly { readonly id: string; readonly label: string }[] = [
  { id: "pull", label: "pull the latest code" },
  { id: "install", label: "install dependencies" },
  { id: "reinstall", label: "rebuild and reinstall the app" },
];

/** One step's work: the fast-forward through the repositories capability, and the two Bun
 * commands through the app's shell. `bun run app:install` internally re-runs the install and the
 * page build — accepted duplication, for three honest visible steps. */
const runStep = (
  root: AbsolutePath,
  id: string,
): Effect.Effect<unknown, CliError | CheckoutError | NotARepository, Repositories> => {
  if (id === "pull")
    return Effect.flatMap(Repositories, (repositories) => repositories.pullFastForward(root));
  if (id === "install") return shOrThrow(["bun", "install"], root);
  return shOrThrow(["bun", "run", "app:install"], root);
};

/** The journal with one step's state; the plan is written whole before anything runs, so a step
 * is always an update in place. */
// Pure and synchronous: nothing for an Effect to wrap.
const withStep = (progress: OperationProgressDto, step: OperationStepDto): OperationProgressDto => ({
  ...progress,
  steps: progress.steps.map((existing) => (existing.id === step.id ? step : existing)),
});

/** The sentence a failed step records: the error's own when it has one, and never empty — an
 * empty error would leave a failed update saying nothing at all. */
// Pure and synchronous: nothing for an Effect to wrap.
const errorDetail = (error: unknown): string => {
  const own =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return own || String(error) || "the update failed";
};

/** What an update decides on: eligibility and what is new. The upstream tip rides along
 * internally — it is the identity one "new version" notice is announced once per. */
type Snapshot = {
  readonly eligible: boolean;
  readonly reason?: string;
  readonly behind: number;
  readonly commits: IncomingCommitDto[];
  readonly compareUrl?: string;
  readonly refusal?: string;
  readonly tip?: string;
};

// Pure and synchronous: nothing for an Effect to wrap.
const ineligible = (reason: string): Snapshot => ({ eligible: false, reason, behind: 0, commits: [] });

/** The facts, gathered live: every read failure becomes a reason, never a defect — a status the
 * page can show is the point, and "could not read the checkout" is one. With `fresh`, the remote
 * is fetched first and a fetch that cannot reach it refuses the update; without it, everything
 * comes from local state and costs no network call. */
const assess = (
  options: AppUpdateOptions,
  fresh: boolean,
): Effect.Effect<Snapshot, never, Repositories> =>
  Effect.gen(function* () {
    // The gate first, before anything touches git: a dev server or a browser-fallback run has no
    // business fetching, and its checkout is not this feature's subject.
    if (!options.app) return yield* Effect.succeed(ineligible("not running as the installed app"));
    const tooling = yield* Effect.sync(
      () => commandAvailable("git") && commandAvailable("bun"),
    );
    if (!tooling) return yield* Effect.succeed(ineligible("git and bun must be on PATH"));
    const repositories = yield* Repositories;
    const root = AbsolutePath.make(options.root);
    const facts = yield* Effect.result(
      Effect.gen(function* () {
        const checkout = yield* repositories.inspectCheckout(root);
        if (checkout._tag === "Missing")
          return ineligible("the app is not running from a git repository");
        if (checkout.branch === undefined) return ineligible("the checkout is on a detached HEAD");
        const defaultBranch = yield* repositories.defaultRemoteBranch(root);
        if (defaultBranch === undefined)
          return ineligible("the checkout has no remote default branch to update from");
        if (checkout.branch !== defaultBranch)
          return ineligible(`not on the ${defaultBranch} branch`);

        // A fetch that fails is not a dead check: the remote-tracking refs still say what was
        // new last time, and the update itself refuses with the reason below.
        const fetched = fresh
          ? yield* Effect.result(repositories.fetchRemote(root))
          : ({ _tag: "Success" } as const);
        const upstream = yield* repositories.inspectUpstream(root);
        const dirty = yield* repositories.workingTreeDirty(root);
        const incoming: readonly IncomingCommit[] =
          upstream.behind > 0 ? yield* repositories.incomingCommits(root) : [];
        const commits = incoming.map((commit) => ({
          sha: commit.sha,
          subject: commit.subject,
          ...(commitUrl(upstream.remoteUrl, commit.sha)
            ? { url: commitUrl(upstream.remoteUrl, commit.sha) }
            : {}),
        }));
        // The refusal matters only beside a new version: without one there is nothing to refuse,
        // and a check that could not reach the remote says nothing at all (silently, logged).
        const refusal =
          upstream.behind === 0
            ? undefined
            : fetched._tag === "Failure"
              ? "could not reach the remote"
              : dirty
                ? "uncommitted changes in the checkout"
                : upstream.ahead > 0
                  ? `${upstream.ahead} unpushed commit(s) in the checkout`
                  : undefined;
        return {
          eligible: true,
          behind: upstream.behind,
          commits,
          ...(comparePage(upstream.remoteUrl, checkout.head ?? "", upstream.tip ?? "")
            ? { compareUrl: comparePage(upstream.remoteUrl, checkout.head ?? "", upstream.tip ?? "") }
            : {}),
          ...(refusal !== undefined ? { refusal } : {}),
          ...(upstream.tip !== undefined ? { tip: upstream.tip } : {}),
        } satisfies Snapshot;
      }),
    );
    return facts._tag === "Failure"
      ? ineligible(`could not read the checkout: ${errorDetail(facts.failure)}`)
      : facts.success;
  });

/** Whether an update finished in this running app: the journal keeps its record across restarts,
 * but the restart it asks for is only pending until the app has done it. */
// Pure and synchronous: nothing for an Effect to wrap.
const restartPending = (progress: OperationProgressDto | null): boolean =>
  progress !== null &&
  progress.finishedAt !== undefined &&
  progress.error === undefined &&
  Date.parse(progress.finishedAt) >= SERVER_STARTED_AT;

// Pure and synchronous: nothing for an Effect to wrap.
const statusFrom = (
  snapshot: Snapshot,
  progress: OperationProgressDto | null,
  checkedAt: string | undefined,
): AppUpdateStatusDto => ({
  eligible: snapshot.eligible,
  ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}),
  ...(checkedAt !== undefined ? { checkedAt } : {}),
  behind: snapshot.behind,
  commits: snapshot.commits,
  ...(snapshot.compareUrl !== undefined ? { compareUrl: snapshot.compareUrl } : {}),
  ...(snapshot.refusal !== undefined ? { refusal: snapshot.refusal } : {}),
  progress,
  restartPending: restartPending(progress),
});

/** What the app knows about updating itself, from the last check and the journal: local reads
 * only, so a page may ask as often as it likes. */
export const updateStatus = (
  options: AppUpdateOptions,
): Effect.Effect<AppUpdateStatusDto, UpdateJournalError, Repositories> =>
  Effect.gen(function* () {
    const snapshot = yield* assess(options, false);
    return statusFrom(snapshot, yield* readJournal(), lastChecked);
  });

/** One check now: fetch, read the facts, and say "update" once per new tip. A tip is announced
 * exactly once — the schedule rediscovers the same version every two hours, and a page that
 * heard it twice would toast it twice. */
export const checkUpdate = (
  options: AppUpdateOptions,
): Effect.Effect<AppUpdateStatusDto, UpdateJournalError, Repositories> =>
  Effect.gen(function* () {
    const snapshot = yield* assess(options, true);
    lastChecked = new Date().toISOString();
    if (snapshot.tip !== undefined && snapshot.behind > 0) {
      if (announcedTip !== snapshot.tip) {
        announcedTip = snapshot.tip;
        announce("update");
      }
    } else {
      announcedTip = undefined;
    }
    return statusFrom(snapshot, yield* readJournal(), lastChecked);
  });

/** The check's owner: once shortly after startup, then every two hours while the server runs.
 * Never blocks the listen, and a check that cannot run is logged rather than fatal. Only the
 * installed app gets a checker at all. */
export const startUpdateChecks = (options: AppUpdateOptions): void => {
  if (!options.app) return;
  const check = (): void => {
    void Effect.runPromise(checkUpdate(options).pipe(Effect.provide(repositoriesLayer))).catch(
      (error: unknown) => console.error("could not check for updates:", error),
    );
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref();
};

/** An update that was running when the server stopped is not running now: its journal is closed
 * here at startup, so the dialog reads "stopped" and offers "Try again" instead of waiting for a
 * run that is gone. */
export const closeInterruptedUpdate = (): Effect.Effect<void, UpdateJournalError> =>
  Effect.gen(function* () {
    const journal = yield* readJournal();
    if (journal === null || journal.finishedAt !== undefined) return;
    const message = "the update was interrupted";
    yield* writeJournal({
      ...journal,
      steps: journal.steps.map((step) =>
        step.state === "running" ? { ...step, state: "failed" as const, detail: message } : step,
      ),
      finishedAt: new Date().toISOString(),
      error: message,
    });
  });

/**
 * Start the update and answer at once with the opening status.
 *
 * The opening reads the facts fresh and decides: "already up to date" answers without a journal
 * when the version moved on by itself, a refusal (uncommitted work, commits that were never
 * pushed, a remote that cannot be reached) names why in place of the button, and otherwise the
 * plan is journaled and the steps run in the background — a minute of Bun is no request's to
 * hold open. The journal is where a page watches the run, so closing the dialog or reloading
 * costs nothing. A second start while one runs is refused, never raced.
 */
export type UpdateStart =
  | { readonly _tag: "Started"; readonly status: AppUpdateStatusDto }
  | { readonly _tag: "AlreadyUpToDate"; readonly status: AppUpdateStatusDto };

export const startUpdate = (
  options: AppUpdateOptions,
): Effect.Effect<UpdateStart, UpdateRefused | UpdateBusy | UpdateJournalError, Repositories> =>
  Effect.gen(function* () {
    if (!(yield* takeGuard()))
      return yield* new UpdateBusy({ reason: "an update is already running" });
    // An opening that fails has taken its last step: release at once, so a refusal costs the
    // next start nothing.
    const opening = yield* openUpdate(options).pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : releaseGuard())),
    );
    if (opening._tag === "AlreadyUpToDate") {
      yield* releaseGuard();
      return opening;
    }
    // The run owns the guard from here to its own end, and says so in the journal as it goes.
    yield* Effect.forkDetach(
      runSteps(options).pipe(
        Effect.catch((error) =>
          Effect.sync(() => console.error("the update stopped:", errorDetail(error))),
        ),
        Effect.ensuring(releaseGuard()),
      ),
    );
    return opening;
  });

/** The opening: read the facts fresh, decide, and journal the plan the run starts from. A
 * stopped or failed run is *continued* — the steps its journal records as done are kept, and
 * the first one that is not runs — while a finished run is history and a new update starts
 * from the top. */
const openUpdate = (
  options: AppUpdateOptions,
): Effect.Effect<UpdateStart, UpdateRefused | UpdateJournalError, Repositories> =>
  Effect.gen(function* () {
    const snapshot = yield* assess(options, true);
    lastChecked = new Date().toISOString();
    const previous = yield* readJournal();
    const continuing =
      previous !== null && (previous.finishedAt === undefined || previous.error !== undefined);
    if (!snapshot.eligible)
      return yield* new UpdateRefused({ reason: snapshot.reason ?? "the app cannot update itself" });
    if (!continuing) {
      if (snapshot.behind === 0)
        return {
          _tag: "AlreadyUpToDate" as const,
          status: statusFrom(snapshot, previous, lastChecked),
        };
      if (snapshot.refusal !== undefined)
        return yield* new UpdateRefused({ reason: snapshot.refusal });
    }
    const kept = new Set(
      continuing && previous !== null
        ? previous.steps.filter((step) => step.state === "done").map((step) => step.id)
        : [],
    );
    const progress: OperationProgressDto = {
      startedAt: new Date().toISOString(),
      steps: STEP_PLAN.map((step) =>
        kept.has(step.id)
          ? { ...step, state: "done" as const }
          : { ...step, state: "waiting" as const },
      ),
    };
    yield* writeJournal(progress);
    return { _tag: "Started" as const, status: statusFrom(snapshot, progress, lastChecked) };
  });

/** The run itself: every step the opening plan has not recorded as done, in order, journaled as
 * it goes. A failed step is recorded before the run stops, so a reload reads what happened
 * rather than a plan that is still "running" for ever. */
const runSteps = (
  options: AppUpdateOptions,
): Effect.Effect<
  void,
  UpdateJournalError | CliError | CheckoutError | NotARepository,
  Repositories
> =>
  Effect.gen(function* () {
    const root = AbsolutePath.make(options.root);
    const opened = yield* readJournal();
    if (opened === null) return;
    let progress = opened;
    for (const step of STEP_PLAN) {
      if (progress.steps.find((existing) => existing.id === step.id)?.state === "done") continue;
      progress = withStep(progress, { ...step, state: "running" });
      yield* writeJournal(progress);
      const outcome = yield* Effect.result(runStep(root, step.id));
      if (outcome._tag === "Failure") {
        const message = errorDetail(outcome.failure);
        progress = {
          ...withStep(progress, { ...step, state: "failed", detail: message }),
          finishedAt: new Date().toISOString(),
          error: message,
        };
        yield* writeJournal(progress);
        return yield* outcome.failure;
      }
      progress = withStep(progress, { ...step, state: "done" });
      yield* writeJournal(progress);
    }
    progress = { ...progress, finishedAt: new Date().toISOString() };
    yield* writeJournal(progress);
  });
