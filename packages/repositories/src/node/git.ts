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

    const resolveExistingBranch = Effect.fn("Git.history.resolveExistingBranch")(function* (
      repository: Git.Repository,
      name: string,
    ) {
      const fail = (message: string): Git.OperationError =>
        new Git.OperationError({ operation: "checkout", directory: repository.worktree, message })
      const refs = yield* run("checkout", repository.worktree, [
        "for-each-ref",
        "--format=%(refname)%09%(upstream)%09%(symref)",
        "refs/heads",
        "refs/remotes",
      ])
      if (refs.exitCode !== 0) return yield* fail(refs.stderr.trim() || "could not read branches")
      const remotes = yield* run("checkout", repository.worktree, ["remote"])
      if (remotes.exitCode !== 0) return yield* fail(remotes.stderr.trim() || "could not read remotes")
      const remoteNames = remotes.stdout.trim().split("\n").filter(Boolean)
        .sort((a, b) => b.length - a.length)
      const entries = refs.stdout.split("\n").filter(Boolean).map((line) => {
        const [ref = "", upstream = "", symref = ""] = line.split("\t")
        return { ref, upstream, symref }
      })
      const locals = entries.filter((entry) => entry.ref.startsWith("refs/heads/"))
      const remoteBranches = entries.filter((entry) => entry.ref.startsWith("refs/remotes/") && !entry.symref)
      const remoteOf = (ref: string): string | undefined =>
        remoteNames.find((remote) => ref.startsWith(`refs/remotes/${remote}/`))
      const resolved = (branch: string, ref?: string): Git.ExistingBranch => {
        const remote = ref ? remoteOf(ref) : undefined
        return { branch, ...(remote && ref ? { remote, remoteRef: ref.slice("refs/remotes/".length) } : {}) }
      }
      // Exact local names win, including names with slashes or names that look remote-qualified.
      const local = locals.find((entry) => entry.ref === `refs/heads/${name}`)
      if (local) {
        const upstream = remoteBranches.find((entry) => entry.ref === local.upstream)?.ref
        const counterpart = remoteBranches.find((entry) => entry.ref === `refs/remotes/origin/${name}`)?.ref
        return resolved(name, upstream ?? (!local.upstream ? counterpart : undefined))
      }
      const explicit = remoteBranches.find((entry) => entry.ref === `refs/remotes/${name}`)
      const candidates = explicit
        ? [explicit]
        : remoteBranches.filter((entry) => {
            const remote = remoteOf(entry.ref)
            return remote && entry.ref === `refs/remotes/${remote}/${name}`
          })
      if (candidates.length !== 1)
        return yield* fail(candidates.length ? `ambiguous remote branch: ${name}` : `branch not found: ${name}`)
      const selected = candidates[0]
      if (!selected) return yield* fail(`branch not found: ${name}`)
      const remote = remoteOf(selected.ref)
      if (!remote) return yield* fail(`branch has no configured remote: ${name}`)
      const branch = selected.ref.slice(`refs/remotes/${remote}/`.length)
      const corresponding = locals.find((entry) => entry.ref === `refs/heads/${branch}`)
      if (corresponding?.upstream && corresponding.upstream !== selected.ref)
        return yield* fail(`local branch ${branch} tracks ${corresponding.upstream}, not ${selected.ref}`)
      return resolved(branch, selected.ref)
    })

    const refExists = Effect.fn("Git.history.refExists")(function* (
      repository: Git.Repository,
      ref: string,
    ) {
      const result = yield* run("upstream", repository.worktree, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ])
      if (result.exitCode === 0) return true
      if (result.exitCode === 1) return false
      return yield* new Git.OperationError({
        operation: "upstream",
        directory: repository.worktree,
        message: result.stderr.trim() || "git rev-parse failed",
      })
    })

    const isAncestor = Effect.fn("Git.history.isAncestor")(function* (
      repository: Git.Repository,
      input: { readonly ancestor: string; readonly descendant: string },
    ) {
      const result = yield* run("integration", repository.worktree, [
        "merge-base",
        "--is-ancestor",
        input.ancestor,
        input.descendant,
      ])
      if (result.exitCode === 0) return true
      if (result.exitCode === 1) return false
      // An unresolvable ref lands here as "not a proof", matching `integration.proven`.
      return false
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

    const hasRemote = Effect.fn("Git.repo.hasRemote")(function* (
      repository: Git.Repository,
      remote?: string,
    ) {
      const result = yield* run("discover", repository.worktree, ["remote"])
      if (result.exitCode !== 0) return false
      const names = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      return remote ? names.includes(remote) : names.length > 0
    })

    const remoteUrl = Effect.fn("Git.repo.remoteUrl")(function* (
      repository: Git.Repository,
      remote = "origin",
    ) {
      const result = yield* run("discover", repository.worktree, ["remote", "get-url", remote])
      return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
    })

    const upstreamTip = Effect.fn("Git.history.upstreamTip")(function* (repository: Git.Repository) {
      const result = yield* run("upstream", repository.worktree, [
        "rev-parse",
        "--verify",
        "--quiet",
        "@{upstream}",
      ])
      return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
    })

    const upstreamCommits = Effect.fn("Git.history.upstreamCommits")(function* (repository: Git.Repository) {
      // One line per commit: the sha, a unit separator no subject can carry, then the subject.
      // An empty range — up to date, or no upstream at all — is an empty list, not a failure.
      const result = yield* run("upstream", repository.worktree, [
        "log",
        "--format=%H%x1f%s",
        "HEAD..@{upstream}",
      ])
      if (result.exitCode !== 0) return []
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line): Git.IncomingCommit => {
          const split = line.indexOf("\x1f")
          return { sha: line.slice(0, split), subject: line.slice(split + 1) }
        })
    })

    const defaultBranch = Effect.fn("Git.history.defaultBranch")(function* (repository: Git.Repository) {
      const remote = yield* defaultRemoteBranch(repository)
      if (remote) return `origin/${remote}`
      for (const name of ["main", "master"]) {
        const exists = yield* run("upstream", repository.worktree, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${name}`,
        ])
        if (exists.exitCode === 0) return name
      }
      return undefined
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

    const fetchRemote = Effect.fn("Git.sync.fetchRemote")(function* (
      repository: Git.Repository,
      remote = "origin",
    ) {
      const result = yield* run("checkout", repository.worktree, ["fetch", "--quiet", remote])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "checkout",
          directory: repository.worktree,
          message: result.stderr.trim() || "git fetch failed",
        })
    })

    const pullFastForward = Effect.fn("Git.sync.pullFastForward")(function* (repository: Git.Repository) {
      const result = yield* run("pull", repository.worktree, ["pull", "--ff-only"])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "pull",
          directory: repository.worktree,
          message: result.stderr.trim() || "git pull --ff-only failed",
        })
    })

    const mergeFastForwardOnly = Effect.fn("Git.sync.mergeFastForwardOnly")(function* (
      repository: Git.Repository,
      input: { readonly to: string },
    ) {
      const result = yield* run("merge", repository.worktree, ["merge", "--ff-only", input.to])
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "merge",
          directory: repository.worktree,
          // The verdict, not git's advice column: a refused fast-forward prints a `hint:` block
          // about rebasing that no report should carry. The refusal is an expected outcome, and
          // this message is the sentence shown for it.
          message:
            result.stderr
              .split("\n")
              .filter((line) => line.trim() && !line.startsWith("hint:"))
              .join(" ")
              .trim() || "git merge --ff-only failed",
        })
    })

    const switchToBranch = Effect.fn("Git.sync.switchToBranch")(function* (
      repository: Git.Repository,
      input: { readonly branch: string; readonly create?: boolean; readonly base?: string; readonly track?: string },
    ) {
      const args = input.track
        ? ["switch", "--create", input.branch, "--track", input.track]
        : input.create
          ? ["switch", "--create", input.branch, ...(input.base ? ["--no-track", input.base] : [])]
          : ["switch", input.branch]
      const result = yield* run("checkout", repository.worktree, args)
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "checkout",
          directory: repository.worktree,
          message: result.stderr.trim() || "git switch failed",
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

    const addWorktree = Effect.fn("Git.worktree.add")(function* (input: {
      readonly repository: Git.Repository
      readonly directory: AbsolutePath
      readonly branch: string
      readonly base?: string
      readonly create: boolean
      readonly track?: string
    }) {
      const args = input.track
        ? ["worktree", "add", "--track", "-b", input.branch, input.directory, input.track]
        : input.create
          ? [
              "-c",
              "branch.autoSetupMerge=false",
              "worktree",
              "add",
              "-b",
              input.branch,
              input.directory,
              ...(input.base ? [input.base] : []),
            ]
          : ["worktree", "add", input.directory, input.branch]
      const result = yield* run("create", input.repository.worktree, args)
      if (result.exitCode !== 0)
        return yield* new Git.OperationError({
          operation: "create",
          directory: input.directory,
          message: result.stderr.trim() || "git worktree add failed",
        })
      const repository = yield* discover(input.directory)
      if (repository) {
        const attached = yield* branch(repository)
        if (attached === input.branch) return repository
        return yield* new Git.OperationError({
          operation: "create",
          directory: input.directory,
          message: `created checkout is not attached to ${input.branch}`,
        })
      }
      return yield* new Git.OperationError({
        operation: "create",
        directory: input.directory,
        message: "created worktree could not be opened",
      })
    })

    return {
      repo: { discover, hasRemote, remoteUrl },
      history: {
        branch,
        head,
        branchExists,
        resolveExistingBranch,
        refExists,
        isAncestor,
        upstream,
        defaultRemoteBranch,
        defaultBranch,
        upstreamTip,
        upstreamCommits,
      },
      status: { dirty: statusDirty },
      integration: { proven: integrationProven },
      sync: { deleteBranch, fetchRemote, pullFastForward, mergeFastForwardOnly, switchToBranch },
      worktree: { remove, add: addWorktree },
    }
  }),
)
