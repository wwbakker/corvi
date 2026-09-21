/** The cutover adapters: the included integrations behind the lifecycle's ports.
 *
 * This is the bridge while the extension host still owns the provider code. Each adapter has a
 * named removal condition: when the included integrations become packages with explicit ports
 * (plan step 6), these layers are replaced, not extended. Nothing here imports a workflow
 * implementation from an integration.
 */
import { Effect, Layer, Option } from "effect"

import { layer as changesNodeLayer, progressLayer, storeLayer } from "@corvi/changes/node"
import type { OperationProgress } from "@corvi/changes/progress"
import { ChangeRepositories } from "@corvi/changes/repositories"
import type { Change as CorviChange, Repository } from "@corvi/contracts/changes"
import { Repositories, layer as repositoriesCapabilityLayer } from "@corvi/repositories"
import {
  Command,
  CommandError,
  gitLayer,
  nodeCommand,
} from "@corvi/repositories/node"
import {
  ChangeLifecycle,
  Issues,
  ProviderError,
  PullRequests,
  TerminalError,
  TerminalSessions,
  layer as changeLifecycleLayer,
  type PullRequestState,
} from "@corvi/workflows/lifecycle"
import { ChangeWork, layer as changeWorkCapabilityLayer } from "@corvi/workflows"
import type { Change as LegacyChange, CompletionStep } from "../domain/change.ts"
import type { Workspace as WorkspaceShape } from "../domain/config.ts"
import { Shell, Workspace } from "../capabilities/effect/tags.ts"
import { messageOf } from "../capabilities/effect/support.ts"
import { capabilitiesLayer, ChangesLive } from "../integrations/services.ts"
import { prLooseEnds } from "../extensions/github/index.ts"
import { closeIssueOnComplete, planIssueClose } from "../extensions/github-issues/index.ts"
import { jiraLooseEnds, moveIssueOnComplete, planIssueCompletion } from "../extensions/jira/index.ts"
import { stopTerminal } from "../terminals/server/index.ts"
import { forgetPrs, mergePr, mergeReadiness, refreshReadiness } from "../vendors/github.ts"
import { runtimeConfig, workspaceById } from "../workspace/server/index.ts"
import { readChange } from "./server/store.ts"

/** The provider functions speak the old domain shape; the store keeps both in one record. */
const toLegacy = (change: CorviChange, links: readonly Repository[]): LegacyChange => ({
  id: change.changeId,
  title: change.title,
  branch: change.branch,
  repos: links.map((link) => link.originalLocation),
  state:
    change.phase === "Implementation"
      ? "In Progress"
      : change.phase === "Verification"
        ? "Awaiting Review"
        : change.phase,
  createdAt: change.createdAt,
  ...(change.completedAt ? { completedAt: change.completedAt } : {}),
})

const providerError = (operation: string, error: unknown): ProviderError =>
  new ProviderError({ provider: "github", operation, message: messageOf(error), cause: error })

/** Git commands through the app's Shell when one is in context — tests script it, and a host
 * may provide it — and through the direct spawner otherwise, mirroring `sh`'s own fallback. */
const shellCommandLayer: Layer.Layer<Command> = Layer.effect(
  Command,
  Effect.gen(function* () {
    const shell = yield* Effect.serviceOption(Shell)
    const workspace = yield* Effect.serviceOption(Workspace)
    return {
      run: (input) => {
        if (Option.isNone(shell)) return nodeCommand.run(input)
        const run = shell.value.run([input.program, ...input.args], { cwd: input.cwd })
        const withWorkspace = Effect.provideService(
          run,
          Workspace,
          Option.isSome(workspace) ? workspace.value : workspaceById(undefined),
        )
        return withWorkspace.pipe(
          Effect.map((result) => ({
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          })),
          Effect.mapError(
            (cause) =>
              new CommandError({ program: input.program, message: cause.message, cause }),
          ),
        )
      },
    }
  }),
)

/** The repositories capability over the real Git adapter, whose commands honour the Shell seam. */
const repositoriesOverShell: Layer.Layer<Repositories> = repositoriesCapabilityLayer.pipe(
  Layer.provide(gitLayer),
  Layer.provide(shellCommandLayer),
)

/** The GitHub vendor behind the pull-request port. `fresh` is the click path: it forgets the
 * change's cached reads and fetches before deciding. Only `Changes` is provided here — never a
 * Shell — so a scripted Shell in context still sees every command. */
export const pullRequestsLayer = (): Layer.Layer<PullRequests, never, ChangeRepositories> =>
  Layer.effect(
    PullRequests,
    Effect.gen(function* () {
      const links = yield* ChangeRepositories

      const linkFor = (
        change: CorviChange,
        repositoryId: string,
      ): Effect.Effect<Repository, ProviderError> =>
        links.listRepositories(change.changeId).pipe(
          Effect.mapError((error) => providerError("resolve", error)),
          Effect.flatMap((all) => {
            const found = all.find((entry) => entry.repositoryId === repositoryId)
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                  new ProviderError({
                    provider: "github",
                    operation: "resolve",
                    message: "the repository is not part of the change",
                  }),
                )
          }),
        )

      /** The provider code still reads ticket keys from the record's extension data, which the
       * new model does not carry; the record is the source until integrations become packages. */
      const legacyFor = (change: CorviChange): Effect.Effect<LegacyChange, ProviderError> =>
        readChange(change.changeId).pipe(
          Effect.mapError((error) => providerError("read", error)),
          Effect.flatMap((record) =>
            record
              ? Effect.succeed(record)
              : links.listRepositories(change.changeId).pipe(
                  Effect.map((all) => toLegacy(change, all)),
                  Effect.mapError((error) => providerError("resolve", error)),
                ),
          ),
        )

      return {
        readiness: ({ change, repository, fresh }) =>
          Effect.gen(function* () {
            const link = yield* linkFor(change, repository.repositoryId)
            const legacy = yield* legacyFor(change)
            if (fresh) yield* forgetPrs(legacy)
            const observed = yield* (fresh
              ? refreshReadiness(legacy, link.originalLocation)
              : mergeReadiness(legacy, link.originalLocation)
            ).pipe(Effect.provide(ChangesLive), Effect.mapError((e) => providerError("readiness", e)))
            const state: PullRequestState = observed.ready
              ? observed.merged
                ? { repository, number: 0, ready: true, merged: true }
                : { repository, number: observed.number, ready: true, merged: false }
              : { repository, number: 0, ready: false, merged: false, reason: observed.reason }
            return state
          }),
        merge: ({ change, repository, number }) =>
          Effect.gen(function* () {
            const link = yield* linkFor(change, repository.repositoryId)
            const legacy = yield* legacyFor(change)
            return yield* mergePr(legacy, link.originalLocation, number).pipe(
              Effect.provide(ChangesLive),
              Effect.mapError((e) => providerError("merge", e)),
            )
          }),
        /** Loose ends are collected through the issues bridge below, which already covers the
         * pull-request lines the old `looseEnds` contributors produce; returning them here too
         * would list each one twice. */
        outstanding: () => Effect.succeed([]),
      }
    }),
  )

/** The included completion steps and loose ends behind the issue port. */
/** What this change's integrations plan to do, planned once and passed around: a plan that
 * could answer differently twice would be two promises about one completion. The included steps
 * are the whole set, in load order (jira before github-issues). */
export const plannedCompletionSteps = (change: LegacyChange): CompletionStep[] =>
  [planIssueCompletion(change, runtimeConfig()), planIssueClose(change)].filter(
    (step): step is CompletionStep => Boolean(step),
  );

export const issuesLayer = (workspace: WorkspaceShape): Layer.Layer<Issues, never, ChangeRepositories> =>
  Layer.effect(
    Issues,
    Effect.gen(function* () {
      const links = yield* ChangeRepositories
      /** The provider steps read ticket keys and repository lists from the old record; that is
       * the source until the integrations become packages. */
      const legacyFor = (change: CorviChange): Effect.Effect<LegacyChange, ProviderError> =>
        readChange(change.changeId).pipe(
          Effect.mapError(
            (error) => new ProviderError({ provider: "issues", operation: "read", message: error.message, cause: error }),
          ),
          Effect.flatMap((record) =>
            record
              ? Effect.succeed(record)
              : links.listRepositories(change.changeId).pipe(
                  Effect.map((all) => toLegacy(change, all)),
                  Effect.mapError(
                    (error) =>
                      new ProviderError({ provider: "issues", operation: "resolve", message: error.message, cause: error }),
                  ),
                ),
          ),
        )

      return {
        plan: (change) =>
          Effect.gen(function* () {
            const legacy = yield* legacyFor(change)
            return plannedCompletionSteps(legacy).map((step) => ({
              id: step.id,
              label: step.label,
              state: "waiting" as const,
            }))
          }),
        run: ({ change, stepId }) =>
          Effect.gen(function* () {
            const legacy = yield* legacyFor(change)
            if (stepId === "jira") {
              yield* moveIssueOnComplete(legacy).pipe(
                Effect.provide(capabilitiesLayer(workspace, "jira")),
                Effect.mapError(
                  (error) =>
                    new ProviderError({
                      provider: "jira",
                      operation: "complete",
                      message: messageOf(error),
                      cause: error,
                    }),
                ),
              )
              return undefined
            }
            if (stepId === "github-issues") {
              return yield* closeIssueOnComplete(legacy).pipe(
                Effect.provide(capabilitiesLayer(workspace, "github-issues")),
                Effect.mapError(
                  (error) =>
                    new ProviderError({
                      provider: "github-issues",
                      operation: "complete",
                      message: messageOf(error),
                      cause: error,
                    }),
                ),
              )
            }
            return undefined
          }),
        current: (change) =>
          Effect.gen(function* () {
            const legacy = yield* legacyFor(change)
            // Pull-request lines first, as the github extension loaded before jira.
            const pullRequests = yield* prLooseEnds(legacy).pipe(
              Effect.provide(capabilitiesLayer(workspace, "github")),
              Effect.catchAll(() => Effect.succeed([] as string[])),
            )
            return [...pullRequests, ...jiraLooseEnds(legacy)]
          }),
      }
    }),
  )

export const terminalSessionsLayer: Layer.Layer<TerminalSessions> = Layer.succeed(TerminalSessions, {
  stop: (changeId) =>
    stopTerminal(changeId).pipe(
      Effect.mapError(
        (error) => new TerminalError({ changeId, message: messageOf(error), cause: error }),
      ),
    ),
})

/** The repositories capability over the native link store, without the lifecycle services. */
export const repositoriesLayer = (roots: {
  readonly root: string;
  readonly archiveRoot: string;
}): Layer.Layer<Repositories | ChangeRepositories> =>
  Layer.merge(
    changesNodeLayer.pipe(Layer.provide(storeLayer(roots))),
    repositoriesOverShell,
  )

/** The start workflow over the native store and the real Git adapter: no provider ports are
 * needed, because its provisioning is all concrete checkouts. */
export const changeWorkLayer = (
  roots: { readonly root: string; readonly archiveRoot: string },
  options: { readonly progress?: Layer.Layer<OperationProgress> } = {},
): Layer.Layer<ChangeWork> =>
  changeWorkCapabilityLayer.pipe(
    Layer.provide(changesNodeLayer),
    Layer.provide(storeLayer(roots)),
    Layer.provide(repositoriesOverShell),
    Layer.provide(options.progress ?? progressLayer({ root: roots.root })),
  )

/** The lifecycle over the native store, the real Git adapter, and the cutover adapters. */
export const lifecycleLayer = (
  workspace: WorkspaceShape,
  roots: { readonly root: string; readonly archiveRoot: string },
  options: { readonly progress?: Layer.Layer<OperationProgress> } = {},
): Layer.Layer<ChangeLifecycle> =>
  changeLifecycleLayer.pipe(
    Layer.provide(pullRequestsLayer()),
    Layer.provide(issuesLayer(workspace)),
    Layer.provide(terminalSessionsLayer),
    Layer.provide(changesNodeLayer),
    Layer.provide(storeLayer(roots)),
    Layer.provide(repositoriesOverShell),
    Layer.provide(options.progress ?? progressLayer({ root: roots.root })),
  )
