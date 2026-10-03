/**
 * The conversational relay: the half of the extension that talks *to* Corvi, not just about the
 * session.
 *
 * When this harness runs inside a Corvi subagent session (the host seeded `CORVI_SUBAGENT_ID`),
 * the relay parks on `corvi subagent next` for the next inbound message, submits it into this
 * session with `pi.sendUserMessage` (a genuine user turn, submitted through the harness's own API
 * — no keystroke synthesis racing a human), waits for the run to settle, and relays the answer
 * back with `corvi subagent turn`.
 *
 * It is deliberately thin: all protocol logic lives in the CLI/server, and this file only turns
 * events into exec calls. The loop is exported and takes its side effects as a value, so a test
 * drives it with a scripted harness instead of a live one.
 *
 * Identity is the environment's `CORVI_SUBAGENT_ID`, seeded per host session by the server, so a
 * reopened subagent carries the same id and resumes the same relay.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { fullTextOf } from "./agent-state.ts";

/** What one CLI call produced. */
export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Exec = (args: readonly string[]) => Promise<ExecResult>;

/** The side effects the loop needs, supplied by the pi wiring or by a test. */
export type RelayHarness = {
  /** Run the Corvi CLI with these arguments. */
  readonly exec: Exec;
  /** Submit an inbound message as a user turn in this session. A rejection is logged, not
   * swallowed: the message is already claimed, so a silent failure would strand the turn. */
  readonly submit: (text: string) => void | Promise<void>;
  /** Resolve with the settled run's assistant text, or undefined when it settled with none. */
  readonly settled: () => Promise<string | undefined>;
  /** Wait before re-issuing a call. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Stop the loop (a test aborts it). */
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

/** Relay one settled reply, retrying with backoff: this is the one call whose payload would be
 * lost if it never lands, so a server restart must not drop it. */
const relayTurn = async (harness: RelayHarness, subagentId: string, text: string, key: string): Promise<void> => {
  const gate = createLogGate(harness.log);
  for (let attempt = 0; ; attempt += 1) {
    if (harness.signal?.aborted) return;
    // `--` before the text: a reply that begins with a dash is data, not a flag.
    const result = await harness.exec([
      "subagent",
      "turn",
      "--subagent",
      subagentId,
      "--idempotency-key",
      key,
      "--json",
      "--",
      text,
    ]);
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
    const next = await call<NextResult>(harness, [
      "subagent",
      "next",
      "--subagent",
      subagentId,
      "--json",
      ...(after === undefined ? [] : ["--after", String(after)]),
    ]);
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
      await harness.submit(message.body);
    } catch (error) {
      harness.log?.(`submitting message ${message.number} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const settled = await harness.settled();
    // A settled run with no text (an abort) still closes the turn, so the subagent is not stranded
    // in flight forever; the note is honest about there being no reply.
    const reply = settled !== undefined && settled.trim() !== "" ? settled : "(the run ended without a reply)";
    await relayTurn(harness, subagentId, reply, `turn-${message.number}`);
  }
};

/** The subagent id this session carries, from the environment the host seeded. Undefined when
 * this is not a subagent session: the reporter still speaks, the relay stays quiet. */
export const subagentOfSession = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const id = env.CORVI_SUBAGENT_ID?.trim();
  return id === undefined || id === "" ? undefined : id;
};

/** pi emits `session_start` again on `/reload`; a second loop would share the single settle slot
 * and deadlock the first. One relay per process. */
let relayStarted = false;

export default function (pi: ExtensionAPI): void {
  // One settle per submitted turn: the handler below resolves it with the run's text.
  let settle: ((text: string | undefined) => void) | undefined;
  let lastAssistant = "";
  pi.on("agent_end", async (event) => {
    for (const message of [...event.messages].reverse()) {
      const text = fullTextOf(message);
      if (text) {
        lastAssistant = text;
        return;
      }
    }
  });
  pi.on("agent_settled", async () => {
    const done = settle;
    settle = undefined;
    done?.(lastAssistant || undefined);
    lastAssistant = "";
  });

  pi.on("session_start", async () => {
    if (relayStarted) return;
    const subagentId = subagentOfSession();
    if (subagentId === undefined) return; // a plain session: the reporter still speaks, the relay stays quiet
    relayStarted = true;
    const harness: RelayHarness = {
      exec: async (args) => pi.exec("corvi", [...args]),
      submit: async (text) => {
        await pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false });
      },
      settled: () =>
        new Promise<string | undefined>((resolve) => {
          settle = resolve;
        }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.error(`[corvi] ${message}`),
    };
    void relayLoop(subagentId, harness);
  });
}
