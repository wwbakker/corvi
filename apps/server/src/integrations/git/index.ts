import { Duration, Effect } from "effect";
import { type Change, specFor } from "@corvi/changes/record";
import { ChangeId } from "@corvi/contracts/changes";
import { Shell, Workspace } from "@corvi/contracts/capabilities";
import { withCheckoutLock } from "@corvi/workflows";
import { existingBranch } from "../../capabilities/repositories.ts";
import { envNumber, shSoft } from "../../capabilities/effect/support.ts";
import { repoItem } from "../../vendors/git.ts";
import { gitRun } from "../../change/provisioning.ts";
import type { IncludedIntegration } from "../types.ts";

/** How stale a card read's knowledge of the remotes may be. The card polls every 15 seconds and a
 * fetch per repository per poll is a network cost nobody asked for; five minutes is as fresh as a
 * dashboard row needs to be, and the Fast-forward click fetches for itself regardless. An
 * environment override lets a test drive the window without sleeping; a positive minimum keeps an
 * empty value from disabling the throttle altogether. */
const CARD_FETCH_MS = (): number => envNumber("CORVI_CARD_FETCH_MS", 5 * 60_000, 1);

/** Nobody waits on a background fetch, so it must not hold a reference or a lock for the shell's
 * two-minute ceiling: give up well before that and let the next window try again. */
const CARD_FETCH_TIMEOUT = Duration.seconds(15);

/** Process-wide bookkeeping for the card's background refreshes: when each repository was last
 * asked to fetch, and which ones are fetching now. One fetch per repository per window, shared by
 * every change that shows it. */
const fetchedAt = new Map<string, number>();
const fetching = new Set<string>();

/** Fetch the remote the checkout policy reads — the existing branch's own remote, else origin —
 * not every remote: an unrelated dead remote would otherwise spend the whole budget. */
const fetchRemote = (repo: string, remote: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const remotes = (yield* shSoft(["git", "remote"], repo)).stdout
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
    if (!remotes.includes(remote)) return;
    yield* shSoft(["git", "fetch", "--quiet", remote], repo);
  });

/** Start a refresh in the background at most once per window — never wait for one on a card read.
 * The row paints from the local refs it already has, and the action appears on the next poll once
 * the fetch lands.
 *
 * The fork carries the card read's own `Workspace` and `Shell`: a per-workspace `env` (git
 * credentials live there) must reach the fetch, and handing over the shell keeps the work
 * scriptable in tests. It runs under the change's checkout lock, so it cannot fight a provision,
 * a repository edit or a Fast-forward over a ref lock; a fetch that fails is silent (the row never
 * claimed more than the local refs) and is not retried until the window turns over. */
const refreshInBackground = (change: Change, repo: string): Effect.Effect<void, never, Workspace | Shell> =>
  Effect.gen(function* () {
    // Only the change's own repositories: a card row for a path it does not list has nothing to
    // fetch, and the action for it would be refused anyway.
    const spec = specFor(change, repo);
    if (spec === undefined) return;
    if (fetching.has(repo)) return;
    const now = Date.now();
    if (now - (fetchedAt.get(repo) ?? 0) < CARD_FETCH_MS()) return;
    // Resolved here, in the request's own context, so the selection reads with the same shell the
    // rest of the card does.
    const remote =
      spec.branch.kind === "existing"
        ? ((yield* existingBranch(repo, spec.branch.name))?.remote ?? "origin")
        : "origin";
    const workspace = yield* Workspace;
    const shell = yield* Shell;
    fetchedAt.set(repo, now);
    fetching.add(repo);
    Effect.runFork(
      withCheckoutLock(ChangeId.make(change.id), fetchRemote(repo, remote)).pipe(
        Effect.timeoutOption(CARD_FETCH_TIMEOUT),
        Effect.provideService(Shell, shell),
        Effect.provideService(Workspace, workspace),
        Effect.ensuring(Effect.sync(() => fetching.delete(repo))),
      ),
    );
  });

/**
 * Local changes: the worktree card, and the change provisioning hooks.
 *
 * The implementation lives in apps/server/src/vendors/git.ts, because half the core — completing,
 * cancelling, committing, browsing — shares its helpers. This extension describes the card and
 * its actions; their effects require nothing beyond the capabilities, so the host provides
 * everything they need.
 *
 * Creating an idea cuts its checkouts straight away: the worktree and the change's branch are
 * there while it is still an idea. What an idea never does is move a ticket — that waits for the
 * change to leave Ideation for a manual phase.
 */
export default {
  name: "git",
  title: "Local changes",

  cards: [
    {
      title: "Local changes",
      // The repository editor is its client half's `edit`; the card only says it has one.
      editable: true,
      repoStatus: (change, repo) =>
        Effect.gen(function* () {
          // A background fetch keeps the next poll's measurement from being stale; this read is
          // painted from the local refs it already has, so an unreachable remote cannot stall it.
          yield* refreshInBackground(change, repo);
          return yield* Effect.map(repoItem(change, repo), (item) => [item]);
        }),
      run: (change, action, repo) => gitRun(change, action, repo),
    },
  ],
} satisfies IncludedIntegration;
