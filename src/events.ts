import { Effect, Exit, Fiber, Option, Schedule, Stream } from "effect";
import { listChangesEffect } from "./changes.ts";
import { allWindowsEffect } from "./terminal.ts";
import { config } from "./config.ts";

/**
 * One connection that says when something changed, instead of every page asking whether it has.
 *
 * The navigation column asked for the terminal windows every 1.5 seconds, the overview asked for
 * the changes every 30, and each open page did it separately — against a browser limit of six
 * connections per origin, which is why the dashboard's widgets have to be unmounted when a
 * terminal is on screen. One `EventSource` replaces all of that: the server watches once and
 * tells whoever is listening.
 *
 * What is pushed is only the *news*, never the data. A page that hears "changes" asks for them,
 * through the same cached routes as before. That keeps this small — no second way to fetch
 * anything, no state to keep in sync — and means a missed event costs a refresh rather than a
 * wrong screen.
 */

type EventName = "changes" | "windows" | "notify";

/** One piece of news: the event name, and the data for the one event that carries any. `changes`
 * and `windows` say "something moved, fetch it", which is what keeps this stream small. */
type News = { event: EventName; data?: string };

type Client = {
  send: (event: string, data: string) => void;
  /** A comment line, which an EventSource ignores and an idle-timeout does not. */
  ping: () => void;
};

const clients = new Set<Client>();

/** How often the server looks. Terminals change under your hands — a command finishes, an agent
 * starts waiting — so this is the interval the navigation column used to poll at, now paid once
 * for everybody rather than once per open page. */
const INTERVAL = Schedule.spaced("1.5 seconds");

/**
 * A colon-comment down the wire now and then, which an EventSource ignores.
 *
 * Not politeness: a connection with nothing on it is an idle connection, and Bun closes those
 * after ten seconds. The browser reconnects, so it half-works — a stream that drops and comes
 * back every ten seconds all day, logging `request timed out` each time.
 */
const HEARTBEAT = "5 seconds";

/** What was last broadcast, to say nothing when nothing happened. Shared with `announce`, which
 * clears one event's entry so the watcher's next look says it again. */
const last = new Map<EventName, string>();

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
    // between, and a dedup on the event NAME would swallow it (the silence there once lost the
    // navigation column; see `startWatcher` for the first-look half of the same story).
    Stream.filterMap((found: Option.Option<News>) => found),
  );

/**
 * The windows tick: one tmux read per interval, used for two things. The serialized read is the
 * `windows` event, exactly as before. The attention edges are computed against the previous
 * successful read — keyed by tmux window id, because reordering the tabs changes indices and an
 * index-keyed diff would report a window that merely moved — and only the edge into "wants you"
 * is news. The state lives in the watcher run, like `last`: a fresh watcher only seeds the
 * picture, so a server that has just started (or a page that has just connected) does not
 * announce every waiting agent it finds, and nothing that happened while nobody listened is
 * replayed.
 */
type Attention = { previous: Map<string, boolean>; seeded: boolean };

const windowsNews = (state: Attention): Stream.Stream<News> =>
  Stream.repeatEffectWithSchedule(
    Effect.gen(function* () {
      const read = yield* Effect.exit(allWindowsEffect());
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
                sound: config.notificationSound,
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

/** Watch the cheap, local things: the change files, and what tmux has. Neither costs a network
 * call, so this can run while anyone is connected and stop when nobody is. */
const watchPipeline = (state: Attention): Effect.Effect<void> =>
  Stream.merge(
    channel("changes", Effect.map(listChangesEffect(), (c) => JSON.stringify(c))),
    windowsNews(state),
  ).pipe(Stream.runForEach((news) => Effect.sync(() => broadcast(news.event, news.data))));

/** The watcher's fiber, while anyone is listening. Ref-counted by the client set: started when
 * the first client registers, interrupted when the last one is forgotten. */
let watcher: Fiber.RuntimeFiber<void, never> | undefined;

function startWatcher(): void {
  if (watcher) return;
  // What was last seen is kept across looks but not across watchers: a fresh watcher has an
  // empty map, so its own first look broadcasts whatever it finds — a page's own fetches can
  // predate the stream by the width of a session starting, and a swallowed first look left a
  // page sitting on stale state for ever. Always announcing costs one redundant refetch per
  // watcher start; the silence cost a missing navigation column. The attention picture is
  // seeded per watcher for the same reason — and so nothing that happened while nobody was
  // watching is announced as if it just did.
  last.clear();
  watcher = Effect.runFork(watchPipeline({ previous: new Map(), seeded: false }));
}

function stopWatcher(): void {
  if (!watcher) return;
  const fiber = watcher;
  watcher = undefined;
  Fiber.interruptFork(fiber);
}

function broadcast(event: EventName, data = ""): void {
  for (const client of clients) {
    try {
      client.send(event, data);
    } catch {
      // Writing to a stream nobody is reading: the connection is gone, whatever we were told.
      forget(client);
    }
  }
}

/** One place, because a client that is not forgotten is a watcher that never stops. */
function forget(client: Client): void {
  if (!clients.delete(client)) return;
  if (clients.size === 0) stopWatcher();
}

/** Tell everyone that something changed, now rather than within a tick.
 *
 * Used by the routes that make the change themselves, so your own action lands immediately. The
 * watcher would catch it anyway, which is what makes this an optimisation and not a duty: a route
 * that forgets to call it is late, not broken. */
export function announce(event: EventName): void {
  last.delete(event);
  broadcast(event);
}

/**
 * The stream itself: `GET /api/events`.
 *
 * The request is needed, not just its response: a closed tab is an *aborted request*, and the
 * stream's own `cancel` is not called for it. Without listening to the signal the client was
 * never forgotten, so the watcher kept looking at the disk and at tmux twice a second for
 * browsers that had been closed for hours. The abort listener and the client fiber's scope
 * finalization both forget the client, so either path alone is enough.
 */
export const eventsEffect = (req: Request): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    let push: ((chunk: Uint8Array) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
      },
      cancel() {
        fiber.unsafeInterruptAsFork(fiber.id());
      },
    });
    const client: Client = {
      send: (event, data) => push!(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)),
      ping: () => push!(encoder.encode(": ping\n\n")),
    };

    // The client lives on a daemon fiber of its own, with a scope whose finalizer forgets it —
    // so interruption from any path (abort signal, stream cancel) always cleans up. The
    // heartbeat is this fiber's own loop: a colon-comment every five seconds, which is what
    // keeps Bun's idle timeout from closing a stream that is quiet by nature.
    const fiber = yield* Effect.forkDaemon(
      Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => forget(client)));
        clients.add(client);
        startWatcher();
        // Says the stream is open, and gives the browser something to receive: an EventSource
        // that has had nothing at all is indistinguishable from one that never connected. The
        // page refetches on open; the watcher's first look covers everything that moves after.
        client.send("open", "");
        yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(HEARTBEAT);
            try {
              client.ping();
            } catch {
              forget(client);
              yield* Effect.interrupt;
            }
          }),
        );
      }),
      ),
    );
    req.signal.addEventListener("abort", () => {
      forget(client);
      fiber.unsafeInterruptAsFork(fiber.id());
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        // Nothing between us and the browser, but a buffering proxy is exactly what would make
        // this look like it works and then not.
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  });

/** Who is listening and whether the server is therefore looking. Exposed for the test that the
 * watcher stops: a process quietly polling the disk and tmux twice a second for a browser closed
 * this morning is the failure worth guarding against. */
export const watchState = (): { listeners: number; watching: boolean } => ({
  listeners: clients.size,
  watching: watcher !== undefined,
});
