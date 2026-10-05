import { Context, Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** No git command in a fixture should ever run this long; a stuck one must fail rather than block
 * the event loop, which would stop both the Effect deadline and Bun's timeout from firing. */
const GIT_TIMEOUT_MS = 20_000

/** git in a fixture's directory. The directory can only vanish while a test runs when something
 * outside the test takes it — which a run once saw happen — and git's own "cannot change to"
 * reads like a typo in the test. Name the real event while the answer is still knowable. */
export const git = (cwd: string, ...args: string[]): string => {
  if (!existsSync(cwd)) {
    throw new Error(
      `the fixture directory ${cwd} is gone before 'git ${args.join(" ")}': something outside the test deleted it mid-run`,
    )
  }
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test",
    },
  }).trim()
}

/** One test's own world: a temp root, a ready `repo` in it, and `makeRepo` for more repositories
 * under the same root. The scope that acquires it owns its destruction — nothing is shared between
 * tests, so the file has no order to it and no test's cleanup can reach another test's directories.
 * The last part is not tidiness: a run once lost a fixture directory mid-test, and everything
 * shared went with it. */
export type FixtureShape = {
  readonly tmp: string
  readonly repo: string
  /** A fresh repository with `origin/main` and `origin/feature` standing in for fetched remote
   * branches — so attaching and the default base have targets — and `origin/HEAD` read as the
   * remote's default. The remote URL itself points nowhere: nothing here fetches. */
  readonly makeRepo: (name: string) => Promise<string>
}

export class Fixture extends Context.Service<Fixture, FixtureShape>()("corvi/test/Fixture") {}

const makeFixture = async (): Promise<FixtureShape> => {
  // macOS: `$TMPDIR` is a symlink (`/var/...` is `/private/var/...`) and git reports the physical
  // path it resolves to — `git rev-parse --show-toplevel` and `git worktree list` both do. A
  // fixture made under the logical spelling would then be compared against its own shadow, so
  // make the two spellings the same: temp where git reports. The paths under test are git's own.
  const tmp = await mkdtemp(join(await realpath(tmpdir()), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-git-`))
  const makeRepo = async (name: string): Promise<string> => {
    const dir = join(tmp, name)
    execFileSync("git", ["init", "-b", "main", dir], { timeout: GIT_TIMEOUT_MS })
    await writeFile(join(dir, "a.txt"), "a\n")
    git(dir, "add", ".")
    git(dir, "commit", "-m", "init")
    git(dir, "remote", "add", "origin", "/nonexistent/repo")
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(dir, "update-ref", "refs/remotes/origin/feature", "HEAD")
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    return dir
  }
  try {
    // `acquireRelease` only registers the release once `makeFixture` resolves, so a failure while
    // building `repo` would otherwise leak the root forever (the default cleaner no longer prunes
    // unknown paths). Remove it here instead.
    return { tmp, repo: await makeRepo("repo"), makeRepo }
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** The fixture is a scoped resource: its finalizer is registered the moment it is acquired, so the
 * deadline's interruption runs it instead of leaving the temp root to a hook that a timed-out body
 * can outlive. */
export const sandboxLayer: Layer.Layer<Fixture> = Layer.effect(
  Fixture,
  Effect.acquireRelease(Effect.promise(makeFixture), (f) =>
    Effect.promise(() => rm(f.tmp, { recursive: true, force: true })),
  ),
)

/** Run `body` against `layer` under a deadline. The timeout bounds the body, not the layer's
 * acquisition, so a slow acquire cannot consume the deadline. Expiring fails the body, and that
 * failure propagates out of the provide, so the layer's scope closes and the release runs. */
export const runScoped = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
  timeoutMs: number,
): Promise<A> => Effect.runPromise(body.pipe(Effect.timeout(timeoutMs), Effect.provide(layer)))
