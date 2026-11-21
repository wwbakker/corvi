/** The dashboard read and checkout provisioning over the capabilities.
 *
 * Workflows are ordinary Effect programs: the route and a future status action call the same
 * function. They compose capabilities; they do not import Git, HTTP, or persistence.
 */
import { Context, Effect, Layer, Semaphore } from "effect";

import { ChangeRepositories } from "@corvi/changes/repositories";
import { ChangeService } from "@corvi/changes/changes";
import { OperationProgress, type OperationStep, type ProgressInterface } from "@corvi/changes/progress";
import { checkoutLocationOf, freshnessTargetOf, stateOf } from "@corvi/changes/rules";
import {
  RepositoryNotFound,
  type ChangeFormatTooNew,
  type ChangeNotFound,
  type ChangeStoreError,
  type RepositoryStoreError,
} from "@corvi/changes/errors";
import { AbsolutePath } from "@corvi/contracts/paths";
import type { Change, ChangeId, Repository, RepositoryId, RepositoryState } from "@corvi/contracts/changes";
import {
  Repositories,
  CheckoutError,
  type CheckoutInspection,
  type ForwardOutcome,
  type NotARepository,
} from "@corvi/repositories";

export type RepositoryView = {
  readonly repository: Repository;
  readonly state: RepositoryState;
  readonly checkoutLocation: string;
  readonly checkout: CheckoutInspection;
};

/** What one repository's refresh did. The fast-forward outcomes come from the capability;
 * `FetchFailed` is the freshness step's own refusal — nothing was created or moved on refs that
 * may be stale — and `None` is the cases with nothing to refresh (adopted as checked out, no
 * base to fast-forward to). */
export type RefreshReport =
  | ForwardOutcome
  | { readonly _tag: "FetchFailed"; readonly reason: string }
  | { readonly _tag: "None"; readonly reason: string };

/** One repository's whole checkout run: fetch, provision, fast-forward. The refresh is always
 * there to read; `error` is why the checkout work stopped, then. */
export type CheckoutOutcome = {
  readonly repository: Repository;
  readonly checkoutLocation: string;
  readonly error?: NotARepository | CheckoutError;
  readonly refresh: RefreshReport;
};

/** One journal entry of an operation that can stop half way. */
export { OperationProgress, type OperationStep, type ProgressInterface } from "@corvi/changes/progress";

export interface Interface {
  readonly inspectChangeRepositories: (
    changeId: ChangeId,
  ) => Effect.Effect<
    readonly RepositoryView[],
    ChangeNotFound | ChangeStoreError | RepositoryStoreError | CheckoutError
  >;
  /** One repository's checkout work, through the one policy creation, repository edits and the
   * row's retry all run: fetch (when there is a remote), provision, then fast-forward-only. A
   * checkout is never created or moved on refs that may be stale, and never rewritten.
   * Unserialized by design: the caller holds `withCheckoutLock` for its whole critical section,
   * as every server checkout operation does — a future caller must do the same. */
  readonly provisionRepository: (
    changeId: ChangeId,
    repositoryId: RepositoryId,
  ) => Effect.Effect<
    CheckoutOutcome,
    ChangeNotFound | RepositoryNotFound | ChangeStoreError | RepositoryStoreError
  >;
  /** Every repository's checkout work, one journal entry per repository. Unserialized like
   * `provisionRepository`: the caller holds `withCheckoutLock`. */
  readonly provisionChange: (
    changeId: ChangeId,
  ) => Effect.Effect<
    readonly CheckoutOutcome[],
    ChangeNotFound | ChangeFormatTooNew | ChangeStoreError | RepositoryStoreError
  >;
  /** One repository's freshness move on the checkout that is already there: fetch the remote its
   * target belongs to, then fast-forward-only to the same ref provisioning advances to. It
   * creates and switches nothing, so a stale click reports instead of provisioning a checkout
   * the row no longer offers. Unserialized like the other two: hold `withCheckoutLock`. */
  readonly refreshRepository: (
    changeId: ChangeId,
    repositoryId: RepositoryId,
  ) => Effect.Effect<
    RefreshReport,
    ChangeNotFound | RepositoryNotFound | ChangeStoreError | RepositoryStoreError
  >;
}

export class ChangeWork extends Context.Service<ChangeWork, Interface>()("corvi/ChangeWork") {}

export const describeProvisionError = (error: NotARepository | CheckoutError): string =>
  error._tag === "NotARepository" ? `${error.directory} is not a repository` : error.message;

/** What the refresh did, in the words the journal shows. */
const describeRefresh = (refresh: RefreshReport): string => {
  switch (refresh._tag) {
    case "Advanced":
      return `advanced to ${refresh.to}`;
    case "Current":
      return "current";
    case "LeftAlone":
      return `left-alone: ${refresh.reason}`;
    case "FetchFailed":
      return `fetch failed: ${refresh.reason}`;
    case "None":
      return refresh.reason;
  }
};

/** What one repository's whole run came to: a stopped run says why, a finished one says what the
 * refresh did. */
export const describeCheckout = (outcome: CheckoutOutcome): string => {
  if (outcome.refresh._tag === "FetchFailed") return describeRefresh(outcome.refresh);
  return outcome.error ? describeProvisionError(outcome.error) : describeRefresh(outcome.refresh);
};

/** One checkout run per change at a time — process-wide, because creation, a repository row's
 * retry and a repository edit arrive on separate requests, each building its own layer instance, and
 * two of them racing would fight over one destination. The lock queues rather than refusing: the
 * second run finds the checkout the first one made and reports it as current. The map grows one
 * small semaphore per change this process has provisioned and is its sole owner.
 *
 * Exported so the server's checkout operations can hold it across their whole critical section —
 * the presence work and a repository teardown included — and the policy runs inside without
 * taking it again. */
const checkoutLocks = new Map<ChangeId, Semaphore.Semaphore>();
const checkoutLockFor = (changeId: ChangeId): Semaphore.Semaphore => {
  // The synchronous section cannot interleave, so a change gets exactly one semaphore.
  const found = checkoutLocks.get(changeId);
  if (found) return found;
  const created = Semaphore.makeUnsafe(1);
  checkoutLocks.set(changeId, created);
  return created;
};

export const withCheckoutLock = <A, E, R>(
  changeId: ChangeId,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => checkoutLockFor(changeId).withPermits(1)(work);

export const layer = Layer.effect(
  ChangeWork,
  Effect.gen(function* () {
    const changes = yield* ChangeService;
    const links = yield* ChangeRepositories;
    const repositories = yield* Repositories;
    const progress = yield* OperationProgress;

    const inspectChangeRepositories = Effect.fn("ChangeWork.inspectChangeRepositories")(function* (
      changeId: ChangeId,
    ) {
      const change = yield* changes.getChange(changeId);
      const repositoriesForChange = yield* links.listRepositories(changeId);
      return yield* Effect.forEach(
        repositoriesForChange,
        (repository) => {
          const checkoutLocation = checkoutLocationOf(change, repository);
          return repositories.inspectCheckout(AbsolutePath.make(checkoutLocation)).pipe(
            Effect.map((checkout): RepositoryView => ({
              repository,
              state: stateOf(change),
              checkoutLocation,
              checkout,
            })),
          );
        },
        { concurrency: 4 },
      );
    });

    /** What a checkout's branch should be fresh against, using this workflow's reads: the base the
     * change chose for it, the repository's default for a change branch, or the remote counterpart
     * of a named existing branch — when that counterpart exists. The choice itself is the shared
     * pure `freshnessTargetOf`, so this and the dashboard card cannot select different kinds of ref. */
    const refreshTargetOf = (
      repository: Repository,
      source: AbsolutePath,
    ): Effect.Effect<string | undefined, NotARepository | CheckoutError> =>
      Effect.gen(function* () {
        const existingRemoteRef =
          repository.branch.kind === "existing"
            ? (yield* repositories.resolveExistingBranch(source, repository.branch.name)).remoteRef
            : undefined;
        const defaultBranch =
          repository.branch.kind === "change" && repository.base === undefined
            ? yield* repositories.defaultBranch(source)
            : undefined;
        return freshnessTargetOf({
          branch: repository.branch,
          base: repository.base,
          existingRemoteRef,
          defaultBranch,
        });
      });

    // The checkout policy belongs to the application: the link's location and branch kind map
    // to the capability's concrete inputs here, and nowhere else. Freshness is one sequence —
    // fetch when there is anything to fetch, provision, fast-forward-only — and a fetch that
    // will not answer stops the repository before anything is created or moved. Every checkout
    // problem is captured as the outcome's data, so one repository's trouble is a report, never
    // a stopped run.
    const provisionLink = (change: Change, repository: Repository): Effect.Effect<CheckoutOutcome> =>
      Effect.gen(function* () {
        const checkoutLocation = checkoutLocationOf(change, repository);
        const source = AbsolutePath.make(repository.originalLocation);
        const outcome = (
          refresh: RefreshReport,
          error?: NotARepository | CheckoutError,
        ): CheckoutOutcome => ({
          repository,
          checkoutLocation,
          refresh,
          ...(error ? { error } : {}),
        });

        // Adopting whatever the checkout has checked out is no work at all — and only possible
        // where that checkout already is. No fetch, no switch, no refresh: the change follows
        // the checkout as it stands. The combination with a new worktree is refused at the wire;
        // a record written by hand can still hold one, and then it is this repository's failure,
        // not the run's.
        if (repository.branch.kind === "current")
          return repository.location === "new"
            ? outcome(
                { _tag: "None", reason: "the checkout was not provisioned" },
                new CheckoutError({
                  operation: "add-worktree",
                  directory: checkoutLocation,
                  message: "a new worktree cannot use the branch a source checkout has checked out",
                }),
              )
            : outcome({ _tag: "None", reason: "adopted as checked out" });

        const selection =
          repository.branch.kind === "existing"
            ? yield* repositories.resolveExistingBranch(source, repository.branch.name).pipe(Effect.result)
            : undefined;
        if (selection?._tag === "Failure")
          return outcome({ _tag: "None", reason: "could not resolve the branch" }, selection.failure);
        const selected = selection?._tag === "Success" ? selection.success : undefined;
        const remoteName = selected?.remote ?? "origin";
        const remote = yield* repositories.hasRemote(source, remoteName).pipe(Effect.result);
        if (remote._tag === "Failure")
          return outcome({ _tag: "None", reason: "could not read the repository" }, remote.failure);
        // New branches still fetch origin; an existing selection fetches the remote its
        // freshness ref belongs to, before attaching or advancing anything.
        if (remote.success) {
          const fetched = yield* repositories.fetchRemote(source, remoteName).pipe(Effect.result);
          if (fetched._tag === "Failure")
            return outcome({ _tag: "FetchFailed", reason: fetched.failure.message }, fetched.failure);
        }

        // Resolve again after fetching: deleted or changed refs must not be attached from stale
        // metadata. Keep the recorded selection for provisioning and the local name for checks.
        const refreshedSelection =
          repository.branch.kind === "existing"
            ? yield* repositories.resolveExistingBranch(source, repository.branch.name).pipe(Effect.result)
            : undefined;
        if (refreshedSelection?._tag === "Failure")
          return outcome(
            { _tag: "None", reason: "could not resolve the branch" },
            refreshedSelection.failure,
          );
        const branch =
          refreshedSelection?._tag === "Success" ? refreshedSelection.success.branch : change.branch;
        const requestedBranch = repository.branch.kind === "existing" ? repository.branch.name : branch;
        // An existing branch is attached — a remote-only one gets a local tracking branch.
        const createMissing = repository.branch.kind === "change";
        const base = repository.branch.kind === "change" ? repository.base : undefined;
        if (repository.location === "original") {
          const attempt = yield* repositories
            .provisionInPlace({ source, branch: requestedBranch, createMissing, ...(base ? { base } : {}) })
            .pipe(Effect.result);
          if (attempt._tag === "Failure")
            return outcome({ _tag: "None", reason: "the checkout was not provisioned" }, attempt.failure);
          // An in-place checkout with uncommitted work is left exactly as it is — it is on no
          // expected branch, so there is nothing to refresh.
          if (attempt.success === "skipped-dirty")
            return outcome({ _tag: "LeftAlone", reason: "uncommitted changes in the checkout" });
        } else {
          const attempt = yield* repositories
            .provisionLinkedWorktree({
              source,
              directory: AbsolutePath.make(checkoutLocation),
              branch: requestedBranch,
              createMissing,
              ...(base ? { base } : {}),
            })
            .pipe(Effect.result);
          if (attempt._tag === "Failure")
            return outcome({ _tag: "None", reason: "the checkout was not provisioned" }, attempt.failure);
        }

        // The plan's promise: a checkout not on the expected branch is never refreshed. An
        // agent or a user may have switched away inside the worktree, and a refresh moves
        // whatever is checked out — including a branch this change never asked for. Nor did
        // provisioning deliver what it promised, which is worth saying where a retry is offered
        // rather than reading as a quiet success. (A dirty in-place checkout already returned
        // above: left alone by policy, not missing its branch.)
        const observed = yield* repositories
          .inspectCheckout(AbsolutePath.make(checkoutLocation))
          .pipe(Effect.result);
        if (observed._tag === "Failure")
          return outcome({ _tag: "None", reason: "could not read the checkout" }, observed.failure);
        const on = observed.success._tag === "Present" ? observed.success.branch : undefined;
        if (on !== branch) {
          const reason = on ? `the checkout is on ${on}, not ${branch}` : `the checkout is not on ${branch}`;
          return outcome(
            { _tag: "LeftAlone", reason },
            new CheckoutError({
              operation: repository.location === "new" ? "add-worktree" : "switch",
              directory: checkoutLocation,
              message: reason,
            }),
          );
        }

        const target = yield* refreshTargetOf(repository, source).pipe(Effect.result);
        if (target._tag === "Failure")
          return outcome({ _tag: "None", reason: "could not read the base" }, target.failure);
        if (!target.success) return outcome({ _tag: "None", reason: "nothing to fast-forward to" });
        const forward = yield* repositories
          .fastForwardBranch({
            directory: AbsolutePath.make(checkoutLocation),
            to: target.success,
          })
          .pipe(Effect.result);
        if (forward._tag === "Failure")
          return outcome({ _tag: "None", reason: "not refreshed" }, forward.failure);
        return outcome(forward.success);
      });

    const linkOf = Effect.fn("ChangeWork.linkOf")(function* (changeId: ChangeId, repositoryId: RepositoryId) {
      const repository = yield* links
        .listRepositories(changeId)
        .pipe(Effect.map((all) => all.find((entry) => entry.repositoryId === repositoryId)));
      if (!repository)
        return yield* new RepositoryNotFound({
          changeId,
          repositoryId,
          message: `repository ${repositoryId} is not part of change ${changeId}`,
        });
      return repository;
    });

    const provisionRepository = Effect.fn("ChangeWork.provisionRepository")(function* (
      changeId: ChangeId,
      repositoryId: RepositoryId,
    ) {
      const change = yield* changes.getChange(changeId);
      return yield* provisionLink(change, yield* linkOf(changeId, repositoryId));
    });

    const provisionChange = Effect.fn("ChangeWork.provisionChange")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId);
      const repositoriesForChange = yield* links.listRepositories(changeId);
      const outcomes: CheckoutOutcome[] = [];
      for (const repository of repositoriesForChange) {
        const label = `checkout ${repository.directoryName}`;
        yield* progress.record({ changeId, step: { id: repository.repositoryId, label, state: "running" } });
        const done = yield* provisionLink(change, repository);
        outcomes.push(done);
        yield* progress.record({
          changeId,
          step: {
            id: repository.repositoryId,
            label,
            ...(done.error ? { state: "failed" as const } : { state: "done" as const }),
            detail: describeCheckout(done),
          },
        });
      }
      return outcomes;
    });

    /** The local branch the link expects and the remote its freshness ref belongs to: the
     * change's own branch on origin, or the selected existing branch and the remote its
     * counterpart is on. */
    const checkoutTargetOf = (
      change: Change,
      repository: Repository,
      source: AbsolutePath,
    ): Effect.Effect<{ readonly branch: string; readonly remote: string }, NotARepository | CheckoutError> =>
      repository.branch.kind === "existing"
        ? Effect.map(repositories.resolveExistingBranch(source, repository.branch.name), (selected) => ({
            branch: selected.branch,
            remote: selected.remote ?? "origin",
          }))
        : Effect.succeed({ branch: change.branch, remote: "origin" });

    /** The freshness move alone. It deliberately repeats the sequence instead of calling
     * `provisionLink` with a "do not provision" flag: the action must never create or switch a
     * checkout (a stale click cannot bring a deleted worktree back), it refuses a dirty checkout
     * up front — including a worktree whose edits do not conflict with the incoming commits, which
     * git itself would happily fast-forward over — and it reports a `RefreshReport` rather than a
     * `CheckoutOutcome`. A flag would have to carry all three differences into provisioning. */
    const refreshRepository = Effect.fn("ChangeWork.refreshRepository")(function* (
      changeId: ChangeId,
      repositoryId: RepositoryId,
    ) {
      const change = yield* changes.getChange(changeId);
      const repository = yield* linkOf(changeId, repositoryId);
      const checkoutLocation = checkoutLocationOf(change, repository);
      const source = AbsolutePath.make(repository.originalLocation);

      // A branch adopted as checked out is never refreshed, so there is nothing to move.
      if (repository.branch.kind === "current")
        return {
          _tag: "None",
          reason: "a branch adopted as checked out is never refreshed",
        } satisfies RefreshReport;

      const expected = yield* checkoutTargetOf(change, repository, source).pipe(Effect.result);
      if (expected._tag === "Failure")
        return { _tag: "None", reason: "could not resolve the branch" } satisfies RefreshReport;

      // The checkout has to be there and on its expected branch: a refresh moves whatever is
      // checked out, so anything else is left alone rather than moved — and nothing is created.
      const observed = yield* repositories
        .inspectCheckout(AbsolutePath.make(checkoutLocation))
        .pipe(Effect.result);
      if (observed._tag === "Failure")
        return { _tag: "None", reason: "could not read the checkout" } satisfies RefreshReport;
      const on = observed.success._tag === "Present" ? observed.success.branch : undefined;
      if (on !== expected.success.branch)
        return {
          _tag: "LeftAlone",
          reason: on
            ? `the checkout is on ${on}, not ${expected.success.branch}`
            : `the checkout is not on ${expected.success.branch}`,
        } satisfies RefreshReport;

      // Uncommitted work is never moved over: a fast-forward that updates a file someone is
      // editing would destroy it, and the policy leaves a dirty checkout alone everywhere else.
      const dirty = yield* repositories
        .workingTreeDirty(AbsolutePath.make(checkoutLocation))
        .pipe(Effect.result);
      if (dirty._tag === "Failure")
        return { _tag: "None", reason: "could not read the checkout" } satisfies RefreshReport;
      if (dirty.success)
        return { _tag: "LeftAlone", reason: "uncommitted changes in the checkout" } satisfies RefreshReport;

      const remote = yield* repositories.hasRemote(source, expected.success.remote).pipe(Effect.result);
      if (remote._tag === "Failure")
        return { _tag: "None", reason: "could not read the repository" } satisfies RefreshReport;
      if (remote.success) {
        const fetched = yield* repositories.fetchRemote(source, expected.success.remote).pipe(Effect.result);
        if (fetched._tag === "Failure")
          return {
            _tag: "FetchFailed",
            reason: fetched.failure.message,
          } satisfies RefreshReport;
      }

      // Resolved after the fetch: the target ref must be the current one, not a stale one.
      const target = yield* refreshTargetOf(repository, source).pipe(Effect.result);
      if (target._tag === "Failure")
        return { _tag: "None", reason: "could not read the base" } satisfies RefreshReport;
      if (!target.success)
        return { _tag: "None", reason: "nothing to fast-forward to" } satisfies RefreshReport;
      const forward = yield* repositories
        .fastForwardBranch({
          directory: AbsolutePath.make(checkoutLocation),
          to: target.success,
        })
        .pipe(Effect.result);
      if (forward._tag === "Failure")
        return { _tag: "LeftAlone", reason: forward.failure.message } satisfies RefreshReport;
      return forward.success;
    });

    return { inspectChangeRepositories, provisionRepository, provisionChange, refreshRepository };
  }),
);
