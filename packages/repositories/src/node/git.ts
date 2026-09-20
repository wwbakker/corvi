/** The real Git adapter: explicit `-C` arguments, no shell, porcelain output parsed strictly.
 *
 * Ported from `opencode/packages/core/src/git.ts` and narrowed to the slice's operations.
 * Exit codes are data; only a spawn failure is a `CommandError`.
 */
import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { Effect, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import * as Git from "../git.ts"
import { Command, type CommandResult } from "./command.ts"

const resolvePath = (cwd: string, value: string): AbsolutePath => {
  const normalized = value.replace(/[\r\n]+$/, "")
  return AbsolutePath.make(isAbsolute(normalized) ? normalized : resolve(cwd, normalized))
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const layer: Layer.Layer<Git.Service, never, Command> = Layer.effect(
  Git.Service,
  Effect.gen(function* () {
    const command = yield* Command

    const run = (
      operation: Git.OperationError["operation"],
      cwd: string,
      args: readonly string[],
    ): Effect.Effect<CommandResult, Git.OperationError> =>
      command.run({ program: "git", args, cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new Git.OperationError({
              operation,
              message: cause.message,
              directory: cwd,
              cause,
            }),
        ),
      )

    const discover = Effect.fn("Git.repo.discover")(function* (directory: AbsolutePath) {
      if (!(yield* Effect.sync(() => isDirectory(directory)))) return undefined
      const [top, gitDir, commonDir] = yield* Effect.all([
        run("discover", directory, ["rev-parse", "--show-toplevel"]),
        run("discover", directory, ["rev-parse", "--git-dir"]),
        run("discover", directory, ["rev-parse", "--git-common-dir"]),
      ])
      if (top.exitCode !== 0 || gitDir.exitCode !== 0 || commonDir.exitCode !== 0) return undefined
      const worktree = top.stdout.trim() ? resolvePath(directory, top.stdout) : directory
      return new Git.Repository({
        worktree,
        gitDirectory: resolvePath(directory, gitDir.stdout),
        commonDirectory: resolvePath(directory, commonDir.stdout),
      })
    })

    const head = Effect.fn("Git.history.head")(function* (repository: Git.Repository) {
      const result = yield* run("discover", repository.worktree, ["rev-parse", "HEAD"])
      return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
    })

    const branch = Effect.fn("Git.history.branch")(function* (repository: Git.Repository) {
      const result = yield* run("discover", repository.worktree, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
      return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
    })

    const branchExists = Effect.fn("Git.history.branchExists")(function* (
      repository: Git.Repository,
      branch: string,
    ) {
      const result = yield* run("upstream", repository.worktree, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ])
      if (result.exitCode === 0) return true
      if (result.exitCode === 1) return false
      return yield* new Git.OperationError({
        operation: "upstream",
        directory: repository.worktree,
        message: result.stderr.trim() || "git show-ref failed",
      })
    })

    const upstream = Effect.fn("Git.history.upstream")(function* (repository: Git.Repository) {
      const branchName = yield* run("upstream", repository.worktree, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
      if (branchName.exitCode !== 0) return { _tag: "NoUpstream" } as const
      const name = branchName.stdout.trim()
      // The config, not the resolved ref: a configured upstream whose target is missing is
      // unavailable, not the same as no upstream at all.
      const configured = yield* run("upstream", repository.worktree, [
        "config",
        "--get",
        `branch.${name}.remote`,
      ])
      if (configured.exitCode !== 0) return { _tag: "NoUpstream" } as const
      const counts = yield* run("upstream", repository.worktree, [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ])
      if (counts.exitCode !== 0) return { _tag: "Unavailable" } as const
      const [ahead, behind] = counts.stdout.trim().split(/\s+/)
      return { _tag: "Counted", ahead: Number(ahead ?? 0), behind: Number(behind ?? 0) } as const
    })

    const defaultRemoteBranch = Effect.fn("Git.history.defaultRemoteBranch")(function* (
      repository: Git.Repository,
      remote = "origin",
    ) {
      const result = yield* run("upstream", repository.worktree, [
        "symbolic-ref",
        `refs/remotes/${remote}/HEAD`,
      ])
      if (result.exitCode !== 0) return undefined
      const ref = result.stdout.trim()
      const prefix = `refs/remotes/${remote}/`
      return ref.startsWith(prefix) ? ref.slice(prefix.length) || undefined : undefined
    })

    const statusDirty = Effect.fn("Git.status.dirty")(function* (repository: Git.Repository) {
      const result = yield* run("status", repository.worktree, ["status", "--porcelain"])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "status",
          directory: repository.worktree,
          message: result.stderr.trim() || "git status failed",
        })
      return result.stdout.trim().length > 0
    })

    const integrationProven = Effect.fn("Git.integration.proven")(function* (
      repository: Git.Repository,
      input: { readonly branch: string; readonly base: string },
    ) {
      // An unknown base or branch is not a proof.
      const base = yield* run("integration", repository.worktree, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${input.base}^{commit}`,
      ])
      if (base.exitCode !== 0) return false
      const branch = yield* run("integration", repository.worktree, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${input.branch}^{commit}`,
      ])
      if (branch.exitCode !== 0) return false
      const ancestor = yield* run("integration", repository.worktree, [
        "merge-base",
        "--is-ancestor",
        input.branch,
        input.base,
      ])
      if (ancestor.exitCode === 0) return true
      if (ancestor.exitCode !== 1)
        return yield* new Git.OperationError({
          operation: "integration",
          directory: repository.worktree,
          message: ancestor.stderr.trim() || "git merge-base failed",
        })
      // Patch equivalence: every branch-only commit has an equivalent patch in the base. An
      // empty range is not a proof on its own; the ancestry check already answered that case.
      const cherry = yield* run("integration", repository.worktree, ["cherry", input.base, input.branch])
      if (cherry.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "integration",
          directory: repository.worktree,
          message: cherry.stderr.trim() || "git cherry failed",
        })
      const lines = cherry.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      return lines.length > 0 && lines.every((line) => line.startsWith("-"))
    })

    const checkoutRemoteBranch = Effect.fn("Git.sync.checkoutRemoteBranch")(function* (
      repository: Git.Repository,
      input: { readonly remote?: string; readonly branch: string; readonly reset?: boolean },
    ) {
      const remote = input.remote ?? "origin"
      const args =
        input.reset === false
          ? ["checkout", input.branch]
          : ["checkout", "-B", input.branch, `${remote}/${input.branch}`]
      const result = yield* run("checkout", repository.worktree, args)
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "checkout",
          directory: repository.worktree,
          message: result.stderr.trim() || "git checkout failed",
        })
    })

    const deleteBranch = Effect.fn("Git.sync.deleteBranch")(function* (
      repository: Git.Repository,
      branch: string,
    ) {
      const result = yield* run("remove", repository.worktree, ["branch", "-D", branch])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "remove",
          directory: repository.worktree,
          message: result.stderr.trim() || "git branch -D failed",
        })
    })

    const create = Effect.fn("Git.worktree.create")(function* (input: {
      readonly repository: Git.Repository
      readonly directory: AbsolutePath
    }) {
      const result = yield* run("create", input.repository.worktree, [
        "worktree",
        "add",
        "--detach",
        input.directory,
        "HEAD",
      ])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "create",
          directory: input.directory,
          message: result.stderr.trim() || "git worktree add failed",
        })
      const repository = yield* discover(input.directory)
      if (repository) return repository
      return yield* new Git.OperationError({
        operation: "create",
        directory: input.directory,
        message: "created worktree could not be opened",
      })
    })

    const remove = Effect.fn("Git.worktree.remove")(function* (input: {
      readonly repository: Git.Repository
      readonly directory: AbsolutePath
      readonly force: boolean
    }) {
      const result = yield* run("remove", input.repository.worktree, [
        "worktree",
        "remove",
        ...(input.force ? ["--force"] : []),
        input.directory,
      ])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "remove",
          directory: input.directory,
          message: result.stderr.trim() || "git worktree remove failed",
        })
    })

    const list = Effect.fn("Git.worktree.list")(function* (repository: Git.Repository) {
      const result = yield* run("list", repository.worktree, ["worktree", "list", "--porcelain"])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "list",
          directory: repository.worktree,
          message: result.stderr.trim() || "git worktree list failed",
        })
      return result.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map(
          (line, index) =>
            new Git.Worktree({
              directory: resolvePath(repository.worktree, line.slice("worktree ".length).trim()),
              kind: index === 0 ? "main" : "linked",
            }),
        )
    })

    return {
      repo: { discover },
      history: { branch, head, branchExists, upstream, defaultRemoteBranch },
      status: { dirty: statusDirty },
      integration: { proven: integrationProven },
      sync: { checkoutRemoteBranch, deleteBranch },
      worktree: { create, remove, list },
    }
  }),
)
