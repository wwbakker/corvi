/**
 * The opencode counterpart of pi's relay: park on `corvi subagent next`, inject the message with
 * the opencode SDK, wait for the session to go idle, and relay the answer with `corvi subagent
 * turn`.
 *
 * The loop is the same shape as pi's (each integration is loaded outside Corvi's module graph and
 * shares no package, so the small core is copied rather than imported). What differs is the
 * harness: the window is launched with `--session <subagent id>`, so the session this window
 * talks through **is** the subagent id — no discovery, and `client.session.promptAsync` targets
 * exactly the visible session. Settling is a non-child `session.status` idle (or the deprecated
 * `session.idle`), with the answer assembled by the reporter's own `trackAnswer`; child sessions
 * (a subagent's own subagents) are ignored, as the reporter ignores them.
 *
 * Identity is the environment's `CORVI_SUBAGENT_ID`, seeded per host session by the server; the
 * window is launched with `--session <subagent id>`, so the session this window talks through is
 * the subagent id, and a reopen resumes it.
 */
import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";

import { trackAnswer } from "./agent-state.ts";
import { logLine } from "./node/log.ts";

type HookEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Exec = (args: readonly string[]) => Promise<ExecResult>;

export type RelayHarness = {
  readonly exec: Exec;
  readonly submit: (text: string) => void | Promise<void>;
  readonly settled: () => Promise<string | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
  /** The jitter source; a test injects a fixed value to pin the backoff. */
  readonly random?: () => number;
};

type NextResult =
  | { readonly status: "message"; readonly message: { readonly number: number; readonly body: string } }
  | { readonly status: "interrupted" | "none" };

/** The relay's retry backoff: exponential from this base, capped, with equal jitter. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** How often one failure streak may log. A failing `next` must not fill the pane's log with one
 * line per process, which is exactly the feedback loop this backoff exists to break. */
const LOG_EVERY_MS = 30_000;

/** The delay for a failed attempt: exponential from the base, capped, with equal jitter (half
 * fixed, half random) so a fleet of relays does not retry in lockstep. */
const backoffMs = (attempt: number, random: () => number): number => {
  const capped = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  return Math.round(capped / 2 + random() * (capped / 2));
};

/** A rate limiter for one failure streak. */
type LogGate = { fail(message: string): void; ok(): void };

/** Rate-limit one failure streak: the first failure logs at once, then at most one line every
 * `everyMs` while it keeps failing. A success reopens it, so the next streak speaks. */
const createLogGate = (
  log: ((message: string) => void) | undefined,
  everyMs = LOG_EVERY_MS,
): LogGate => {
  let lastAt = 0;
  let due = true;
  return {
    fail: (message: string): void => {
      const now = Date.now();
      if (!due && now - lastAt < everyMs) return;
      due = false;
      lastAt = now;
      log?.(message);
    },
    ok: (): void => {
      due = true;
    },
  };
};

/** Whether the runtime is gone. A helper, not `signal.aborted === true` inline: `aborted` is a
 * readonly property, so TypeScript narrows an inline check to `false` for every later await. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** One abort promise per signal: racing this everywhere means one `abort` listener for the relay's
 * whole life, not one per turn and per backoff (an `AbortSignal` accumulates listeners silently). */
const abortPromises = new WeakMap<AbortSignal, Promise<undefined>>();
const aborted = (signal: AbortSignal): Promise<undefined> => {
  if (signal.aborted) return Promise.resolve(undefined);
  const existing = abortPromises.get(signal);
  if (existing !== undefined) return existing;
  const promise = new Promise<undefined>((resolve) =>
    signal.addEventListener("abort", () => resolve(undefined), { once: true }),
  );
  abortPromises.set(signal, promise);
  return promise;
};

/** Resolve with the value, or with `undefined` as soon as the signal aborts: a disposed relay must
 * not park forever on work the old runtime will never finish. */
export const abortable = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> => {
  if (signal === undefined) return promise;
  return Promise.race([promise, aborted(signal)]);
};

/** Sleep, resolving early when the runtime is torn down, so a disposed relay stops promptly. The
 * abort promise is shared, so a backoff adds no listener of its own. */
export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void aborted(signal).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const parse = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** A CLI call's answer, or the reason it did not answer usefully. */
type CallResult<T> = { readonly value: T } | { readonly failed: string };

const call = async <T>(harness: RelayHarness, args: readonly string[]): Promise<CallResult<T>> => {
  const result = await harness.exec(args);
  if (result.code !== 0) {
    return { failed: `corvi ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}` };
  }
  const value = parse<T>(result.stdout);
  return value === undefined
    ? { failed: `corvi ${args.join(" ")} answered malformed JSON` }
    : { value };
};

/** Relay one settled reply, retrying with backoff: `inReplyTo` is the inbound message number the
 * run answered, so the reply is attributed to its own turn. */
const relayTurn = async (
  harness: RelayHarness,
  subagentId: string,
  text: string,
  key: string,
  inReplyTo: number,
): Promise<void> => {
  const gate = createLogGate(harness.log);
  for (let attempt = 0; ; attempt += 1) {
    if (harness.signal?.aborted) return;
    // `--` before the text: a reply that begins with a dash is data, not a flag.
    const result = await abortable(harness.exec([
      "subagent",
      "turn",
      "--subagent",
      subagentId,
      "--idempotency-key",
      key,
      "--in-reply-to",
      String(inReplyTo),
      "--json",
      "--",
      text,
    ]), harness.signal);
    if (result === undefined || isAborted(harness.signal)) return;
    if (result.code === 0) return;
    gate.fail(`relaying the turn failed (attempt ${attempt + 1}): ${result.stderr.trim()}`);
    await harness.sleep(backoffMs(attempt, harness.random ?? Math.random));
  }
};

/** The loop: next → submit → settle → turn, forever. Exported for a scripted test. */
export const relayLoop = async (subagentId: string, harness: RelayHarness): Promise<void> => {
  const random = harness.random ?? Math.random;
  const gate = createLogGate(harness.log);
  let after: number | undefined;
  let attempt = 0;
  while (!harness.signal?.aborted) {
    const next = await abortable(call<NextResult>(harness, [
      "subagent",
      "next",
      "--subagent",
      subagentId,
      "--json",
      ...(after === undefined ? [] : ["--after", String(after)]),
    ]), harness.signal);
    // A poll that lost the race, or resolved just as the runtime was torn down, must not be
    // processed: the server has claimed its message, and a mid-poll abort leaves the turn as the
    // existing `interrupted` (its deliberate recovery path, never requeued).
    if (next === undefined || isAborted(harness.signal)) return;
    if ("failed" in next) {
      gate.fail(next.failed);
      await harness.sleep(backoffMs(attempt, random));
      attempt += 1;
      continue;
    }
    if (next.value.status === "interrupted") {
      gate.fail("the previous turn did not settle; waiting for a new message");
      await harness.sleep(backoffMs(attempt, random));
      attempt += 1;
      continue;
    }
    // A success — a message or the long poll's own deadline — resets the streak.
    gate.ok();
    attempt = 0;
    if (next.value.status !== "message") continue; // the long poll's deadline: re-issue at once
    const message = next.value.message;
    after = message.number;
    try {
      await abortable(Promise.resolve(harness.submit(message.body)), harness.signal);
    } catch (error) {
      harness.log?.(`submitting message ${message.number} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isAborted(harness.signal)) return;
    const settled = await abortable(harness.settled(), harness.signal);
    // The runtime was torn down while the run was in flight: nobody will read a reply, so stop
    // rather than relay it into a disposed harness.
    if (isAborted(harness.signal)) return;
    const reply = settled !== undefined && settled.trim() !== "" ? settled : "(the run ended without a reply)";
    await relayTurn(harness, subagentId, reply, `turn-${message.number}`, message.number);
  }
};

/** The subagent id this session carries, from the environment the host seeded. Undefined when
 * this is not a subagent session. */
export const subagentOfSession = (env: NodeJS.ProcessEnv = process.env): string | undefined => {  const id = env.CORVI_SUBAGENT_ID?.trim();
  return id === undefined || id === "" ? undefined : id;
};

const relay: PluginModule = {
  id: "corvi-relay",
  server: async (input: PluginInput): Promise<Hooks> => {
    const subagentId = subagentOfSession();
    if (subagentId === undefined) return { event: async (): Promise<void> => {} };

    const answer = trackAnswer();
    let settle: ((text: string | undefined) => void) | undefined;

    const settleNow = (): void => {
      const done = settle;
      settle = undefined;
      done?.(answer.fullAnswer() || undefined);
    };

    const exec: Exec = async (args) => {
      const command = ["corvi", ...args].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
      const result = await input.$`sh -c ${command}`.quiet().nothrow();
      // A command killed by a signal has a null exit code; treat that as failure, not success.
      return {
        code: result.exitCode ?? 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };

    // The window was launched with `--session <subagentId>`, so that is the visible session.
    const controller = new AbortController();
    const signal = controller.signal;
    // The loop's rejection must never escape: an unhandled rejection here would take opencode down
    // with it, closing every subagent.
    void relayLoop(subagentId, {
      exec,
      submit: async (text) => {
        await input.client.session
          .promptAsync({ path: { id: subagentId }, body: { parts: [{ type: "text", text }] } })
          .catch((error: unknown) => {
            logLine(`injecting the message failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      },
      settled: () =>
        new Promise<string | undefined>((resolve) => {
          settle = resolve;
        }),
      sleep: (ms) => abortableSleep(ms, signal),
      signal,
      log: (message) => logLine(message),
    }).catch((error: unknown) => {
      try {
        logLine(`the relay stopped with an error: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // A sink that cannot write must not become the unhandled rejection this catch prevents.
      }
    });

    return {
      // opencode calls this through `@opencode-ai/plugin`'s `Hooks.dispose` when it unloads or
      // reloads the plugin. A subagent's pane closing ends the subagent anyway, so a `dispose`
      // that never fires is still bounded.
      dispose: async (): Promise<void> => {
        controller.abort();
      },
      event: async ({ event }: { event: HookEvent }): Promise<void> => {
        try {
          switch (event.type) {
            case "message.updated": {
              const info = event.properties.info;
              // Only this window's own session: a child session is a subagent's own subagent.
              if (info.sessionID !== subagentId) return;
              if (info.role === "user") {
                if (info.summary) return;
                answer.clear();
              } else if (!info.summary) {
                answer.begin(info.id);
              }
              return;
            }
            case "message.part.updated": {
              const part = event.properties.part;
              if (part.sessionID !== subagentId) return;
              if (part.type === "text") answer.addPart(part.messageID, part.id, part.text, part.ignored);
              return;
            }
            case "session.status": {
              if (event.properties.sessionID !== subagentId) return;
              if (event.properties.status.type === "idle") settleNow();
              return;
            }
            case "session.idle": {
              if (event.properties.sessionID !== subagentId) return;
              settleNow();
              return;
            }
            case "session.error": {
              // An error may not be followed by idle; settle so the turn does not strand.
              if (subagentId !== undefined && event.properties.sessionID !== subagentId) return;
              settleNow();
              return;
            }
          }
        } catch {
          // A shape this file did not expect: leave the relay as it is rather than throw inside
          // the agent loop.
        }
      },
    };
  },
};

export default relay;
