/** The cutover adapters: the included integrations behind the lifecycle's ports.
 *
 * This is the bridge while the extension host still owns the provider code. Each adapter has a
 * named removal condition: when the included integrations become packages with explicit ports
 * (plan step 6), these layers are replaced, not extended. Nothing here imports a workflow
 * implementation from an integration.
 */
import { Effect, Layer } from "effect"

import { layer as changesNodeLayer, progressLayer, storeLayer } from "@corvi/changes/node"
import { ChangeRepositories } from "@corvi/changes/repositories"
import type { Change as CorviChange, Repository } from "@corvi/contracts/changes"
import { layer as repositoriesNodeLayer } from "@corvi/repositories/node"
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
import type { Change as LegacyChange } from "../domain/change.ts"
import type { Workspace as WorkspaceShape } from "../domain/config.ts"
import { messageOf } from "../capabilities/effect/support.ts"
import { capabilitiesLayer } from "../extension-host/services.ts"
import { completionStepsFor, looseEndContributorsFor } from "../extension-host/index.ts"
import { stopTerminal } from "../terminals/server/index.ts"
import { forgetPrs, mergePr, mergeReadiness, refreshReadiness } from "../vendors/github.ts"
import { config, workspaceOf } from "../workspace/server/index.ts"
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

/** The GitHub vendor behind the pull-request port. `fresh` is the click path: it forgets the
 * change's cached reads and fetches before deciding. */
export const pullRequestsLayer = (
  workspace: WorkspaceShape,
): Layer.Layer<PullRequests, never, ChangeRepositories> =>
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
            ).pipe(Effect.provide(capabilitiesLayer(workspace, "github")), Effect.mapError((e) => providerError("readiness", e)))
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
              Effect.provide(capabilitiesLayer(workspace, "github")),
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
        transition: (change) =>
          Effect.gen(function* () {
            const legacy = yield* legacyFor(change)
            const notes: string[] = []
            for (const { name, contribution } of completionStepsFor(workspace)) {
              const planned = contribution.plan(legacy, { config, workspace })
              if (!planned) continue
              const note = yield* contribution.run(legacy).pipe(
                Effect.provide(capabilitiesLayer(workspace, name)),
                Effect.mapError(
                  (error) =>
                    new ProviderError({
                      provider: name,
                      operation: "complete",
                      message: messageOf(error),
                      cause: error,
                    }),
                ),
              )
              if (typeof note === "string") notes.push(note)
            }
            return notes.length > 0 ? notes.join("; ") : undefined
          }),
        current: (change) =>
          Effect.gen(function* () {
            const legacy = yield* legacyFor(change)
            const lines: string[] = []
            for (const { name, contribution } of looseEndContributorsFor(workspace)) {
              const found = yield* contribution.looseEnds(legacy).pipe(
                Effect.provide(capabilitiesLayer(workspace, name)),
                Effect.catchAll(() => Effect.succeed([] as string[])),
              )
              lines.push(...found)
            }
            return lines
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

/** The lifecycle over the native store, the real Git adapter, and the cutover adapters. */
export const lifecycleLayer = (
  workspace: WorkspaceShape,
  roots: { readonly root: string; readonly archiveRoot: string },
): Layer.Layer<ChangeLifecycle> =>
  changeLifecycleLayer.pipe(
    Layer.provide(pullRequestsLayer(workspace)),
    Layer.provide(issuesLayer(workspace)),
    Layer.provide(terminalSessionsLayer),
    Layer.provide(changesNodeLayer),
    Layer.provide(storeLayer(roots)),
    Layer.provide(repositoriesNodeLayer),
    Layer.provide(progressLayer({ root: roots.root })),
  )
