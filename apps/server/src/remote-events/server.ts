/** The remote-event fan-in: hold one SSE subscription per configured remote workspace and re-emit
 * what it says on the local bus, tagged with the workspace's source.
 *
 * The page keeps its one local `EventSource`. For every remote workspace in the config this opens
 * `<remote.url>/api/events` with the workspace's device token, parses the named events, and calls
 * `announceFromSource`. The stream is reconnected with a bounded backoff; `reconcile` starts and
 * stops subscriptions as the config changes, and `stop` ends them on shutdown.
 *
 * Nothing here reaches the page directly. The token lives in the config and is only ever an
 * `Authorization` header on the upstream request.
 */
import { Effect } from "effect";

import type { RemoteWorkspaceDto } from "@corvi/contracts/config";
import { announceFromSource } from "../capabilities/bus.ts";
import { runtimeConfig } from "../capabilities/runtime.ts";

/** The remote event names the fan-in forwards. `open` and anything unknown are ignored. */
const EVENT_NAMES = new Set(["changes", "windows", "notify", "update", "power"]);
type Forwarded = "changes" | "windows" | "notify" | "update" | "power";

export type RemoteEvents = {
  /** Start, stop or restart subscriptions to match `runtimeConfig().workspaces`. */
  reconcile: () => Effect.Effect<void>;
  /** Abort every subscription, for a signal handler that is about to exit. */
  stop: () => void;
};

/** What identifies a subscription: the same source with the same target need not restart. */
const targetKey = (remote: RemoteWorkspaceDto): string => `${remote.url}\n${remote.token ?? ""}`;

/** The remote's events URL, or undefined when the url is not http(s) (the 2.1 note: never fetch a
 * scheme the config should not hold). */
const eventsUrl = (remoteUrl: string): URL | undefined => {
  try {
    const base = new URL(remoteUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") return undefined;
    return new URL(`${remoteUrl.replace(/\/+$/, "")}/api/events`);
  } catch {
    return undefined;
  }
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Statuses `fetch` would follow; the subscription refuses them instead, so a remote cannot point
 * the fan-in at another origin. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A frame may be this large; a remote that never sends a blank line is cut off here rather than
 * growing local memory. */
const MAX_FRAME_BYTES = 1 << 20;

/** Wait, but wake early when the subscription is aborted. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Bounded: half a second doubling to thirty. */
const backoffMs = (attempt: number): number => Math.min(30_000, 500 * 2 ** attempt);

/** The earliest blank line, whatever it is spelled with (`\n\n` or `\r\n\r\n`). */
const separatorAt = (buffer: string): { readonly at: number; readonly length: number } | undefined => {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { at: crlf, length: 4 };
  return { at: lf, length: 2 };
};

/** One SSE frame: its `event` name and its joined `data`. Comments (the heartbeat) are ignored. */
const parseFrame = (frame: string): { event?: string; data: string } => {
  let event: string | undefined;
  const data: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
};

/** Read frames until the stream ends. Returns whether any event was seen — the reconnect pace
 * only backs off for a stream that actually delivered, not for one that answered and ended. */
const readEvents = async (
  response: Response,
  onEvent: (event: string, data: string) => void,
): Promise<boolean> => {
  if (response.body === null) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let delivered = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return delivered;
      buffer += decoder.decode(value, { stream: true });
      let separator = separatorAt(buffer);
      while (separator !== undefined) {
        const frame = buffer.slice(0, separator.at);
        buffer = buffer.slice(separator.at + separator.length);
        const parsed = parseFrame(frame);
        if (parsed.event !== undefined) {
          delivered = true;
          onEvent(parsed.event, parsed.data);
        }
        separator = separatorAt(buffer);
      }
      // What is left is one incomplete frame; a remote that never completes it must not grow this.
      if (buffer.length > MAX_FRAME_BYTES) {
        throw new Error("the remote events stream sent a frame larger than the bound");
      }
    }
  } finally {
    reader.releaseLock();
  }
};

/** Connect once and read until the stream ends; throws on a refusal or a redirect. */
const connectAndRead = async (
  source: string,
  url: URL,
  token: string | undefined,
  signal: AbortSignal,
): Promise<boolean> => {
  const response = await fetch(url, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    signal,
    // Never let a configured remote point the fan-in at another origin.
    redirect: "manual",
  });
  if (REDIRECT_STATUSES.has(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("the remote events stream redirected off its origin");
  }
  if (!response.ok || response.body === null) {
    throw new Error(`the remote events stream answered ${response.status}`);
  }
  return readEvents(response, (event, data) => {
    if (EVENT_NAMES.has(event)) announceFromSource(source, event as Forwarded, data);
  });
};

/** Subscribe forever, reconnecting with a bounded backoff until aborted. */
const run = async (source: string, remote: RemoteWorkspaceDto, signal: AbortSignal): Promise<void> => {
  const url = eventsUrl(remote.url);
  if (url === undefined) {
    console.error(`workspace "${source}" names a remote url that is not http(s); its events are not watched`);
    return;
  }
  let attempt = 0;
  let reported = false;
  while (!signal.aborted) {
    try {
      const delivered = await connectAndRead(source, url, remote.token, signal);
      // Only a stream that actually delivered resets the pace and the log: a remote that answers
      // 200 and immediately ends is not healthy, and must not reconnect every half second.
      if (delivered) {
        attempt = 0;
        reported = false;
      }
    } catch (error) {
      // A remote that is down or restarting is expected; the backoff keeps the retry quiet.
      if (!signal.aborted && !reported) {
        console.error(`could not watch events for "${source}": ${messageOf(error)}; retrying`);
        reported = true;
      }
    }
    await sleep(backoffMs(attempt), signal);
    attempt = Math.min(attempt + 1, 6);
  }
};

const subscribe = (source: string, remote: RemoteWorkspaceDto): { readonly key: string; readonly stop: () => void } => {
  const controller = new AbortController();
  void run(source, remote, controller.signal);
  return { key: targetKey(remote), stop: () => controller.abort() };
};

export const makeRemoteEvents = (): RemoteEvents => {
  const active = new Map<string, { readonly key: string; readonly stop: () => void }>();

  const reconcile = (): void => {
    const wanted = new Map<string, RemoteWorkspaceDto>();
    for (const workspace of runtimeConfig().workspaces) {
      if (workspace.remote !== undefined) wanted.set(workspace.id, workspace.remote);
    }
    // A source that is gone, or whose target changed, is no longer the same subscription.
    for (const [source, current] of active) {
      const target = wanted.get(source);
      if (target === undefined || targetKey(target) !== current.key) {
        current.stop();
        active.delete(source);
      }
    }
    for (const [source, remote] of wanted) {
      if (!active.has(source)) active.set(source, subscribe(source, remote));
    }
  };

  return {
    reconcile: (): Effect.Effect<void> => Effect.sync(reconcile),
    stop: (): void => {
      for (const current of active.values()) current.stop();
      active.clear();
    },
  };
};
