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
};

type NextResult =
  | { readonly status: "message"; readonly message: { readonly number: number; readonly body: string } }
  | { readonly status: "interrupted" | "none" };

const RETRY_MS = 1000;

const parse = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

const call = async <T>(harness: RelayHarness, args: readonly string[]): Promise<T | undefined> => {
  const result = await harness.exec(args);
  if (result.code !== 0) {
    harness.log?.(`corvi ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
    return undefined;
  }
  return parse<T>(result.stdout);
};

const relayTurn = async (harness: RelayHarness, subagentId: string, text: string, key: string): Promise<void> => {
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
    harness.log?.(`relaying the turn failed (attempt ${attempt + 1}): ${result.stderr.trim()}`);
    await harness.sleep(Math.min(RETRY_MS * 2 ** attempt, 30_000));
  }
};

/** The loop: next → submit → settle → turn, forever. Exported for a scripted test. */
export const relayLoop = async (subagentId: string, harness: RelayHarness): Promise<void> => {
  let after: number | undefined;
  while (!harness.signal?.aborted) {
    const next = await call<NextResult>(harness, [
      "subagent",
      "next",
      "--subagent",
      subagentId,
      "--json",
      ...(after === undefined ? [] : ["--after", String(after)]),
    ]);
    if (next === undefined) {
      await harness.sleep(RETRY_MS);
      continue;
    }
    if (next.status === "interrupted") {
      harness.log?.("the previous turn did not settle; waiting for a new message");
      await harness.sleep(RETRY_MS);
      continue;
    }
    if (next.status !== "message") continue;
    after = next.message.number;
    try {
      await harness.submit(next.message.body);
    } catch (error) {
      harness.log?.(`submitting message ${next.message.number} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const settled = await harness.settled();
    const reply = settled !== undefined && settled.trim() !== "" ? settled : "(the run ended without a reply)";
    await relayTurn(harness, subagentId, reply, `turn-${next.message.number}`);
  }
};

/** The subagent id this session carries, from the environment the host seeded. Undefined when
 * this is not a subagent session. */
const subagentOfSession = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const id = env.CORVI_SUBAGENT_ID?.trim();
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
    void relayLoop(subagentId, {
      exec,
      submit: async (text) => {
        await input.client.session
          .promptAsync({ path: { id: subagentId }, body: { parts: [{ type: "text", text }] } })
          .catch((error: unknown) => {
            console.error(`[corvi] injecting the message failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      },
      settled: () =>
        new Promise<string | undefined>((resolve) => {
          settle = resolve;
        }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.error(`[corvi] ${message}`),
    });

    return {
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
