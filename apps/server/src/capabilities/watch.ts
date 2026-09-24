import { Effect, Exit, Option, Schedule, Stream } from "effect";
import { listChanges, readSidecar } from "../change/server/store.ts";
import { isFinished, PLAN_FILE } from "../domain/change.ts";
import { textRevision } from "./files.ts";
import { allWindows } from "../terminals/server/index.ts";
import { runtimeConfig } from "../workspace/server/index.ts";

/**
 * What the server watches, and what it counts as news.
 *
 * The policy lives here, apart from the transport that pushes it (`./bus.ts`): which sources are
 * looked at, on what cadence, what counts as a change, and which transitions are worth telling
 * someone about. The transport owns the connections, the heartbeat and the ref-count that starts
 * and stops this.
 *
 * What is news is only ever the *name* of an event, never the data behind it: a page that hears
 * "changes" asks for them through the same cached routes, so a missed event costs a refresh
 * rather than a wrong screen. The one exception is `notify`, which carries the sentence a
 * notification shows — it has no route to re-read.
 */
export type EventName = "changes" | "windows" | "notify";

export type News = { event: EventName; data?: string };

/** How often the server looks. Terminals change under your hands — a command finishes, an agent
 * starts waiting — so this is a fast cadence, paid once for everybody rather than once per open
 * page. */
const INTERVAL = Schedule.spaced("1.5 seconds");

/** What was last broadcast, to say nothing when nothing happened. `forgetWatchedNews` clears one
 * event's entry so the next look says it again after an action that made it true. */
const last = new Map<EventName, string>();

/** An action that changes the world itself says so at once; the next look would otherwise stay
 * quiet because it sees the same state the action just announced. */
export const forgetWatchedNews = (event: EventName): void => {
  last.delete(event);
};

/** One channel of the watcher: read, drop consecutive duplicates (including consecutive failed
 * reads, which `Stream.changes` folds together), and say the event name when there is news.
 *
 * A read that fails — no tmux server yet, a change being written as we look — is not news: it
 * arrives as `Option.none()`, which the stream drops, and the next tick will find it. */
const channel = (
  event: EventName,
  read: Effect.Effect<string, unknown>,
): Stream.Stream<News> =>
  Stream.repeatEffectWithSchedule(
    Effect.gen(function* () {
      const payload = Option.fromNullable(
        yield* Effect.orElseSucceed(read, () => null),
      );
      if (Option.isNone(payload)) return Option.none();
      if (last.get(event) === payload.value) return Option.none();
      last.set(event, payload.value);
      return Option.some({ event });
    }),
    INTERVAL,
  ).pipe(
    // What counts as news was decided above, against the serialized state: two ticks that read
    // the same state both return None, and a second transition in a row is real news — a terminal
    // that came up within the watcher's first interval goes {} -> one window with no quiet tick
    // between, and a dedup on the event NAME would swallow it. See `watch` for the first-look
    // half of the same story.
    Stream.filterMap((found: Option.Option<News>) => found),
  );

/**
 * The windows tick: one tmux read per interval, used for two things. The serialized read is the
 * `windows` event. The attention edges are computed against the previous successful read — keyed
 * by tmux window id, because reordering the tabs changes indices and an index-keyed diff would
 * report a window that merely moved — and only the edge into "wants you" is news. The state
 * lives in the watcher run, like `last`: a fresh watcher only seeds the picture, so a server
 * that has just started (or a page that has just connected) does not announce every waiting
 * agent it finds, and nothing that happened while nobody listened is replayed.
 */
type Attention = { previous: Map<string, boolean>; seeded: boolean };

const windowsNews = (state: Attention): Stream.Stream<News> =>
  Stream.repeatEffectWithSchedule(
    Effect.gen(function* () {
      const read = yield* Effect.exit(allWindows());
      if (!Exit.isSuccess(read)) return []; // no tmux yet, or a read being written as we look
      const windows = read.value;
      const news: News[] = [];
      const serialized = JSON.stringify(windows);
      if (last.get("windows") !== serialized) {
        last.set("windows", serialized);
        news.push({ event: "windows" });
      }
      const seen = new Set<string>();
      for (const [change, list] of Object.entries(windows)) {
        for (const window of list) {
          const key = `${change}:${window.id}`;
          seen.add(key);
          const was = state.previous.get(key);
          state.previous.set(key, window.attention);
          if (state.seeded && window.attention && was === false) {
            news.push({
              event: "notify",
              data: JSON.stringify({
                change,
                window: window.id,
                label: window.label,
                ...(window.note ? { note: window.note } : {}),
                sound: runtimeConfig().notificationSound,
              }),
            });
          }
        }
      }
      // A window that is gone forgets its state: one that comes back is new again, and may
      // notify again.
      for (const key of [...state.previous.keys()]) if (!seen.has(key)) state.previous.delete(key);
      state.seeded = true;
      return news;
    }),
    INTERVAL,
  ).pipe(Stream.flatMap((news) => Stream.fromIterable(news)));

/**
 * Watch the cheap, local things: the change files, and what tmux has. Neither costs a network
 * call, so this runs while anyone is connected and stops when nobody is. `sink` is the
 * transport's broadcast; the effect runs until it is interrupted.
 *
 * What was last seen is kept across looks but not across watchers: every run starts with an
 * empty map, so its own first look says whatever it finds — a page's own fetches can predate the
 * stream by the width of a session starting, and a swallowed first look would leave a page
 * sitting on stale state for ever. Always announcing costs one redundant refetch per watcher
 * start; the silence would cost a missing navigation column. The attention picture is seeded per
 * watcher for the same reason — and so nothing that happened while nobody was watching is
 * announced as if it just did.
 */
export const watch = (sink: (news: News) => void): Effect.Effect<void> =>
  Effect.gen(function* () {
    last.clear();
    yield* Stream.merge(
      channel(
        "changes",
        Effect.gen(function* () {
          const changes = yield* listChanges();
          // The plans ride along with the records: PLAN.md edited outside Corvi — by an agent or
          // an IDE — is news too, which is what keeps an open plan page from saving over it.
          // Finished changes are skipped: their plan is a record nothing writes.
          const live = changes.filter((c) => !isFinished(c));
          const revisions = yield* Effect.forEach(live, (c) =>
            Effect.map(readSidecar(c.id, PLAN_FILE), textRevision),
          );
          return JSON.stringify(changes) + "|" + revisions.join(",");
        }),
      ),
      windowsNews({ previous: new Map(), seeded: false }),
    ).pipe(Stream.runForEach((news) => Effect.sync(() => sink(news))));
  });
