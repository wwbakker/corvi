import { listChanges } from "./changes.ts";
import { allWindows } from "./terminal.ts";

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

type Client = {
  send: (event: string, data: string) => void;
  /** A comment line, which an EventSource ignores and an idle-timeout does not. */
  ping: () => void;
  close: () => void;
};

const clients = new Set<Client>();

/** How often the server looks. Terminals change under your hands — a command finishes, an agent
 * starts waiting — so this is the interval the navigation column used to poll at, now paid once
 * for everybody rather than once per open page. */
const INTERVAL = 1500;

let watching: ReturnType<typeof setInterval> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/**
 * A colon-comment down the wire now and then, which an EventSource ignores.
 *
 * Not politeness: a connection with nothing on it is an idle connection, and Bun closes those
 * after ten seconds. The browser reconnects, so it half-works — a stream that drops and comes
 * back every ten seconds all day, logging `request timed out` each time.
 */
const HEARTBEAT = 5000;
/** What was last broadcast, to say nothing when nothing happened. */
const last = new Map<string, string>();

/** Watch the cheap, local things: the change files, and what tmux has. Neither costs a network
 * call, so this can run while anyone is connected and stop when nobody is. */
async function look(): Promise<void> {
  await Promise.all([
    poll("changes", async () => JSON.stringify(await listChanges())),
    poll("windows", async () => JSON.stringify(await allWindows())),
  ]);
}

async function poll(event: string, read: () => Promise<string>): Promise<void> {
  let now: string;
  try {
    now = await read();
  } catch {
    return; // no tmux server yet, a change being written as we look: the next tick will find it
  }
  if (last.get(event) === now) return;
  // Broadcast every transition, including the watcher's own first look. The old code stayed
  // silent there — "a page that has just connected has asked for all of this anyway" — but a
  // page's own fetches can predate the stream by the width of a session starting: the terminal
  // comes up between the page's request and the watcher's first look, the transition is
  // swallowed as "already there", and the page sits on stale state for ever. Always announcing
  // costs one redundant refetch per watcher start; the silence cost a missing navigation column.
  last.set(event, now);
  broadcast(event, "");
}

function broadcast(event: string, data: string): void {
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
  if (clients.size === 0) stop();
}

/**
 * Tell everyone that something changed, now rather than within a tick.
 *
 * Used by the routes that make the change themselves, so your own action lands immediately. The
 * watcher would catch it anyway, which is what makes this an optimisation and not a duty: a route
 * that forgets to call it is late, not broken.
 */
export function announce(event: "changes" | "windows"): void {
  last.delete(event);
  broadcast(event, "");
}

function start(): void {
  if (watching) return;
  // Unref'd: a watcher is not a reason for the process to stay alive.
  watching = setInterval(() => void look(), INTERVAL);
  watching.unref?.();
  heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.ping();
      } catch {
        forget(client);
      }
    }
  }, HEARTBEAT);
  heartbeat.unref?.();
}

function stop(): void {
  if (!watching) return;
  clearInterval(watching);
  watching = undefined;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  // What was last seen is kept. Forgetting it made the first look after every reconnect a silent
  // one, so anything that changed while nobody was listening — or in the moment between
  // connecting and the first tick — was swallowed instead of announced.
}

/**
 * The stream itself: `GET /api/events`.
 *
 * The request is needed, not just its response: a closed tab is an *aborted request*, and the
 * stream's own `cancel` is not called for it. Without listening to the signal the client was
 * never forgotten, so the watcher kept looking at the disk and at tmux twice a second for
 * browsers that had been closed for hours.
 */
export function events(req: Request): Response {
  const encoder = new TextEncoder();
  let self: Client;

  const stream = new ReadableStream({
    start(controller) {
      self = {
        send: (event, data) =>
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)),
        ping: () => controller.enqueue(encoder.encode(": ping\n\n")),
        close: () => controller.close(),
      };
      clients.add(self);
      start();
      // Says the stream is open, and gives the browser something to receive: an EventSource that
      // has had nothing at all is indistinguishable from one that never connected. The page
      // refetches on open; the watcher's look — which now broadcasts every transition it finds,
      // its own first one included — covers everything that moves after that.
      self.send("open", "");
      req.signal.addEventListener("abort", () => forget(self));
    },
    cancel() {
      forget(self);
    },
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
}

/** Who is listening and whether the server is therefore looking. Exposed for the test that the
 * watcher stops: a process quietly polling the disk and tmux twice a second for a browser closed
 * this morning is the failure worth guarding against. */
export const watchState = (): { listeners: number; watching: boolean } => ({
  listeners: clients.size,
  watching: watching !== undefined,
});
