/**
 * The opencode counterpart of pi's relay: park on `corvi subagent next`, inject the message with
 * the opencode SDK, wait for the session to go idle, and relay the answer with `corvi subagent
 * turn`.
 *
 * The loop is the same shape as pi's (each integration is loaded outside Corvi's module graph and
 * shares no package, so the small core is copied rather than imported). What differs is the
 * harness: injection is `client.session.promptAsync` — "create and send a new message to a
 * session, start if needed and return immediately" — and settling is a non-child
 * `session.status` idle, with the answer assembled by the reporter's own `trackAnswer`.
 *
 * Identity is `@subagent_id` on this pane, read with the plugin's shell (`input.$`).
 */
import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";

import { trackAnswer } from "./agent-state.ts";

type HookEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Exec = (args: readonly string[]) => Promise<ExecResult>;

export type RelayHarness = {
  readonly exec: Exec;
  readonly submit: (text: string) => void;
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
    const result = await harness.exec([
      "subagent",
      "turn",
      "--subagent",
      subagentId,
      "--idempotency-key",
      key,
      "--json",
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
    harness.submit(next.message.body);
    const reply = await harness.settled();
    if (reply !== undefined && reply.trim() !== "") {
      await relayTurn(harness, subagentId, reply, `turn-${next.message.number}`);
    }
  }
};

const relay: PluginModule = {
  id: "corvi-relay",
  server: async (input: PluginInput): Promise<Hooks> => {
    const pane = process.env.TMUX_PANE;
    if (!pane) return { event: async (): Promise<void> => {} };

    const answer = trackAnswer();
    // The session this window is talking through: the newest non-child session opencode reports.
    let sessionID: string | undefined;
    let settle: ((text: string | undefined) => void) | undefined;

    const settleNow = (): void => {
      const done = settle;
      settle = undefined;
      done?.(answer.answer() || undefined);
    };

    const exec: Exec = async (args) => {
      const command = ["corvi", ...args].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
      const result = await input.$`sh -c ${command}`.quiet().nothrow();
      return {
        code: result.exitCode ?? 0,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };

    const readSubagent = async (): Promise<string | undefined> => {
      const result = await input.$`tmux display -p -t ${pane} '#{@subagent_id}'`.quiet().nothrow();
      const id = result.stdout.toString().trim();
      return id === "" ? undefined : id;
    };

    const subagentId = await readSubagent();
    if (subagentId !== undefined) {
      void relayLoop(subagentId, {
        exec,
        submit: (text) => {
          const id = sessionID;
          if (id === undefined) return; // no session known yet; the next turn will find it
          void input.client.session
            .promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } })
            .catch(() => {});
        },
        settled: () =>
          new Promise<string | undefined>((resolve) => {
            settle = resolve;
          }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: (message) => console.error(`[corvi] ${message}`),
      });
    }

    return {
      event: async ({ event }: { event: HookEvent }): Promise<void> => {
        try {
          switch (event.type) {
            case "message.updated": {
              const info = event.properties.info;
              if (info.role === "user") {
                if (info.summary) return;
                answer.clear();
              } else if (!info.summary) {
                answer.begin(info.id);
              }
              sessionID = info.sessionID;
              return;
            }
            case "message.part.updated": {
              const part = event.properties.part;
              if (part.type === "text") answer.addPart(part.messageID, part.id, part.text, part.ignored);
              return;
            }
            case "session.status": {
              if (event.properties.status.type === "idle") settleNow();
              return;
            }
            case "session.idle": {
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
