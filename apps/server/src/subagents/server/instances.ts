/**
 * Subagent instances: create, open, close, message, and wait.
 *
 * Composes three things: the instance store (`@corvi/agents/node`, one directory per subagent),
 * the terminal (`@corvi/terminals`, one tmux window per attached subagent), and the waiter
 * registry (`./waiters.ts`, the long poll's parking lot). The server is the single writer of the
 * `session.json` records and the message files; every mutation goes through the store's
 * per-subagent lock.
 *
 * Presence is a live window carrying `@subagent_id` — written by the server here, read back with
 * the window list. Activity is the reporter's `@agent_status`. The one stored fact is `inFlight`:
 * whether a turn was in flight cannot be derived after a reboot, so it is written when `next`
 * hands a message over and cleared when the reply settles.
 */
import { Effect } from "effect";

import { launchOf, launchCommand } from "@corvi/agents/harness";
import {
  viewOf,
  type SubagentMessage,
  type SubagentRecord,
  type SubagentWithMessages,
} from "@corvi/agents/instance";
import {
  appendMessage,
  createInstance,
  instanceDir,
  readInstance,
  listInstances,
  writeRecord,
} from "@corvi/agents/node";
import type {
  SubagentCreateRequestDto,
  SubagentInstanceDto,
  SubagentNextResponseDto,
  SubagentWaitResponseDto,
} from "@corvi/contracts/subagents";
import { BadRequestError, ConflictError, NotFoundError } from "@corvi/contracts/errors";
import { announce } from "../../capabilities/bus.ts";
import { changeDir } from "../../change/server/index.ts";
import {
  ensureSession,
  killWindow,
  newWindowRunning,
  sessions,
  setPaneOption,
} from "../../terminals/server/index.ts";
import type { Change } from "../../domain/change.ts";
import { resolveProfileFor } from "./run.ts";
import { awaitEvent, notify } from "./waiters.ts";

/** How long a `wait`/`next` parks before answering "nothing yet". The caller re-issues. Read per
 * call, so a test can shorten it. */
const longPollMs = (): number => Number(process.env.CORVI_SUBAGENT_POLL_MS) || 30_000;

const now = (): string => new Date().toISOString();

type Live = { readonly window: string; readonly agentStatus?: "working" | "waiting" };

/** The live windows carrying a `@subagent_id`, keyed by subagent id. A tmux that times out is
 * an empty map: presence is best-effort, never a request failure. */
const liveBySubagent = (changeId: string): Effect.Effect<Map<string, Live>> =>
  Effect.map(
    sessions.windows(changeId, ["@subagent_id", "@agent_status"]).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    ),
    (windows) => {
      const map = new Map<string, Live>();
      for (const window of windows) {
        const id = window.options["@subagent_id"]?.trim();
        if (!id) continue;
        const status = window.options["@agent_status"];
        map.set(id, {
          window: window.id,
          ...(status === "working" || status === "waiting" ? { agentStatus: status } : {}),
        });
      }
      return map;
    },
  );

const toDto = (
  record: SubagentWithMessages,
  live: Live | undefined,
): SubagentInstanceDto => {
  const view = viewOf(
    record,
    { attached: live !== undefined, agentStatus: live?.agentStatus },
    record.messages,
  );
  return {
    id: record.id,
    changeId: record.changeId,
    profile: record.profile,
    label: record.label,
    harness: record.harness,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    ...view,
    log: record.log,
    messages: [...record.messages],
  };
};

const notFound = (id: string): NotFoundError => new NotFoundError({ message: `no such subagent: ${id}` });

const requireInstance = (change: Change, id: string): Effect.Effect<SubagentWithMessages, NotFoundError> =>
  Effect.flatMap(readInstance(changeDir(change), id), (record) =>
    record === null ? Effect.fail(notFound(id)) : Effect.succeed(record),
  );

/** The DTO for one instance, freshly read with its live window. */
export const refreshSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentInstanceDto, NotFoundError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    const live = (yield* liveBySubagent(change.id)).get(id);
    return toDto(record, live);
  });

export const listSubagents = (change: Change): Effect.Effect<readonly SubagentInstanceDto[]> =>
  Effect.gen(function* () {
    const records = yield* listInstances(changeDir(change));
    const live = yield* liveBySubagent(change.id);
    return records.map((record) => toDto(record, live.get(record.id)));
  });

export const showSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentInstanceDto, NotFoundError> => refreshSubagent(change, id);

/** A filename-shaped id derived from the label, with a timestamp and a counter for uniqueness. */
const uniqueId = (change: Change, label: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "subagent";
    const stamp = now().replace(/[-:T.]/g, "").slice(0, 15);
    for (let attempt = 1; ; attempt += 1) {
      const id = attempt === 1 ? `${slug}-${stamp}` : `${slug}-${stamp}-${attempt}`;
      const taken = yield* readInstance(changeDir(change), id);
      if (taken === null) return id;
    }
  });

/** Start the harness in a window of its own: the subagent's directory is the cwd, and the pane
 * carries `@subagent_id` so the window list can match it back. Writes the updated record. */
const openWindow = (change: Change, record: SubagentRecord): Effect.Effect<SubagentRecord, BadRequestError> =>
  Effect.gen(function* () {
    const dir = instanceDir(changeDir(change), record.id);
    yield* ensureSession(change.id, changeDir(change)).pipe(
      Effect.mapError((failure) => new BadRequestError({ message: failure.message })),
    );
    const launch = launchOf({
      harness: record.harness,
      sessionId: record.id,
      label: record.label,
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.effort === undefined ? {} : { effort: record.effort }),
    });
    const window = yield* newWindowRunning(change.id, dir, launchCommand(launch), {
      keepOpen: false,
      cwd: dir,
    }).pipe(Effect.mapError((failure) => new BadRequestError({ message: failure.message })));
    yield* setPaneOption(window, "@subagent_id", record.id).pipe(
      Effect.mapError((failure) => new BadRequestError({ message: failure.message })),
    );
    const updated: SubagentRecord = {
      ...record,
      window,
      log: [...record.log, { kind: "opened", at: now() }],
    };
    yield* writeRecord(changeDir(change), updated).pipe(
      Effect.mapError((error) => new BadRequestError({ message: error.message })),
    );
    yield* Effect.sync(() => announce("windows"));
    return updated;
  });

/** Create a subagent from a profile, open its window, and (when a task was given) append the
 * initial inbound message. Create, open and the first message are bound on purpose: it is the
 * one act, after which opening and starting work are separate. */
/** How an instance's window is opened. The default is the terminal; a test can supply one that
 * records the call instead of starting a harness, which is the only part of create/open that
 * touches tmux. */
export type SubagentLauncher = (
  change: Change,
  record: SubagentRecord,
) => Effect.Effect<SubagentRecord, BadRequestError>;

export const createSubagent = (
  change: Change,
  input: SubagentCreateRequestDto,
  launcher: SubagentLauncher = openWindow,
): Effect.Effect<SubagentInstanceDto, BadRequestError | ConflictError | NotFoundError> =>
  Effect.gen(function* () {
    if (change.completedAt) {
      return yield* new BadRequestError({ message: "this change is finished: no new subagents" });
    }
    const profile = yield* resolveProfileFor(change, input.profile);
    if (!profile) {
      return yield* new BadRequestError({ message: `no such profile: ${input.profile}` });
    }
    const from = input.from ?? "orchestrator";
    const id = yield* uniqueId(change, profile.profile.label);
    const record: SubagentRecord = {
      id,
      changeId: change.id,
      profile: profile.key,
      label: profile.profile.label,
      harness: profile.profile.harness,
      ...(profile.profile.model === undefined ? {} : { model: profile.profile.model }),
      ...(profile.profile.effort === undefined ? {} : { effort: profile.profile.effort }),
      createdBy: from,
      createdAt: now(),
      log: [{ kind: "created", at: now() }],
    };
    yield* createInstance(changeDir(change), record).pipe(
      Effect.mapError(() => new ConflictError({ message: `subagent "${id}" already exists` })),
    );
    if (input.prompt !== undefined && input.prompt !== "") {
      yield* appendMessage(changeDir(change), id, { role: from, body: input.prompt, at: now() }).pipe(
        Effect.mapError((error) => new BadRequestError({ message: error.message })),
      );
    }
    yield* launcher(change, record);
    return yield* refreshSubagent(change, id);
  });

export const openSubagent = (
  change: Change,
  id: string,
  launcher: SubagentLauncher = openWindow,
): Effect.Effect<SubagentInstanceDto, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    const live = (yield* liveBySubagent(change.id)).get(id);
    if (live !== undefined) return toDto(record, live);
    yield* launcher(change, record);
    return yield* refreshSubagent(change, id);
  });

export const closeSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentInstanceDto, NotFoundError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    if (record.window !== undefined) {
      yield* killWindow(record.window).pipe(Effect.catchAll(() => Effect.void));
    }
    const closed: SubagentRecord = {
      ...record,
      window: undefined,
      log: [...record.log, { kind: "closed", at: now() }],
    };
    yield* writeRecord(changeDir(change), closed).pipe(Effect.catchAll(() => Effect.void));
    yield* notify(change.id, id, { kind: "lost", id });
    yield* Effect.sync(() => announce("windows"));
    return yield* refreshSubagent(change, id);
  });

/** Append an inbound message and wake `next`. An open `inFlight` — an interrupted turn — is set
 * aside first, with a `continued` entry, so the new message is what the extension receives; this
 * is what the one-click Continue sends. */
export const sendToSubagent = (
  change: Change,
  id: string,
  text: string,
  from: "orchestrator" | "user",
): Effect.Effect<SubagentMessage, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    if (record.inFlight !== undefined) {
      yield* writeRecord(changeDir(change), {
        ...record,
        inFlight: undefined,
        log: [...record.log, { kind: "continued", at: now(), note: "a new message arrived" }],
      }).pipe(Effect.catchAll(() => Effect.void));
    }
    const message = yield* appendMessage(changeDir(change), id, { role: from, body: text, at: now() }).pipe(
      Effect.mapError((error) => new BadRequestError({ message: error.message })),
    );
    yield* notify(change.id, id, { kind: "inbound", id, message });
    yield* Effect.sync(() => announce("changes"));
    return message;
  });

/** A settled subagent turn, relayed by the harness extension. Clears `inFlight`, appends the
 * reply, and wakes `wait` and the UI. */
export const recordTurn = (
  change: Change,
  id: string,
  text: string,
): Effect.Effect<SubagentMessage, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    const message = yield* appendMessage(changeDir(change), id, { role: "subagent", body: text, at: now() }).pipe(
      Effect.mapError((error) => new BadRequestError({ message: error.message })),
    );
    yield* writeRecord(changeDir(change), {
      ...record,
      inFlight: undefined,
      log: record.inFlight === undefined ? record.log : [...record.log, { kind: "turn_settled", at: now() }],
    }).pipe(Effect.catchAll(() => Effect.void));
    yield* notify(change.id, id, { kind: "reply", id, message });
    yield* Effect.sync(() => announce("changes"));
    return message;
  });

/** The latest subagent message: the current deliverable. */
export const resultOfSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentMessage | null, NotFoundError> =>
  Effect.map(requireInstance(change, id), (record) => {
    const reply = [...record.messages].reverse().find((message) => message.role === "subagent");
    return reply ?? null;
  });

const pendingInbound = (record: SubagentWithMessages): SubagentMessage | undefined => {
  const through = record.deliveredThrough ?? 0;
  return record.messages.find((message) => message.role !== "subagent" && message.number > through);
};

/** The extension's half: the next message to submit, an interrupted turn to leave alone, or
 * nothing yet. The cursor (`deliveredThrough`) and `inFlight` are advanced together, under the
 * store's lock, so a restarted extension cannot be handed a message it already submitted. */
export const nextForSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentNextResponseDto, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + longPollMs();
    for (;;) {
      const record = yield* requireInstance(change, id);
      if (record.inFlight !== undefined) return { status: "interrupted" };
      const pending = pendingInbound(record);
      if (pending) {
        yield* writeRecord(changeDir(change), {
          ...record,
          deliveredThrough: pending.number,
          inFlight: pending.number,
          log: [...record.log, { kind: "turn_started", at: now(), note: `message ${pending.number}` }],
        }).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));
        return { status: "message", message: pending };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "none" };
      const event = yield* awaitEvent(change.id, id).pipe(Effect.timeoutOption(remaining));
      if (event._tag === "None") return { status: "none" };
      if (event.value.kind === "interrupted") return { status: "interrupted" };
      // An inbound or reply event: loop and re-read, which is where the message is picked up.
    }
  });

/** The latest subagent message with a number above the token, if one is already there. */
const deliveredSince = (
  record: SubagentWithMessages,
  token: number,
): SubagentMessage | undefined =>
  [...record.messages]
    .filter((message) => message.role === "subagent" && message.number > token)
    .sort((left, right) => left.number - right.number)
    .at(0);

export type WaitInput = {
  readonly id?: string;
  readonly since?: number;
  readonly mode: "one" | "any" | "all";
};

/** Block until a subagent delivers a turn (or its window is lost), with the plan's outcomes:
 * `turn`, `lost`, `interrupted`, `timeout`. `--all` waits for every target; a lost or
 * interrupted slot resolves the wait rather than blocking forever. */
export const waitForTurn = (
  change: Change,
  input: WaitInput,
): Effect.Effect<SubagentWaitResponseDto, NotFoundError> =>
  Effect.gen(function* () {
    const records = yield* listInstances(changeDir(change));
    const targets = input.id === undefined ? records.map((record) => record.id) : [input.id];
    if (input.id !== undefined && !records.some((record) => record.id === input.id)) {
      return yield* Effect.fail(notFound(input.id));
    }
    if (targets.length === 0) return { status: "timeout" };

    // The baseline is captured once: waiting returns the next turn, so a reply that arrived
    // before the wait does not resolve it. `--since` overrides the baseline for a caller that
    // already read the log up to a point.
    const baseline = new Map<string, number>();
    for (const record of records) {
      baseline.set(
        record.id,
        input.since ?? record.messages.reduce((max, message) => Math.max(max, message.number), 0),
      );
    }

    const waitOne = (id: string): Effect.Effect<SubagentWaitResponseDto> =>
      Effect.gen(function* () {
        for (;;) {
          const record = yield* requireInstance(change, id).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (record === null) return { status: "lost" as const, id };
          const delivered = deliveredSince(record, baseline.get(id) ?? 0);
          if (delivered) return { status: "turn" as const, id, message: delivered };
          const event = yield* awaitEvent(change.id, id);
          if (event.kind === "reply") return { status: "turn" as const, id, message: event.message };
          if (event.kind === "inbound") continue;
          if (event.kind === "lost") return { status: "lost" as const, id };
          return { status: "interrupted" as const, id };
        }
      });

    const waits = targets.map(waitOne);
    if (input.mode === "all") {
      const settled = yield* Effect.all(waits).pipe(Effect.timeoutOption(longPollMs()));
      if (settled._tag === "None") return { status: "timeout" };
      const lost = settled.value.find((result) => result.status === "lost");
      if (lost) return lost;
      const interrupted = settled.value.find((result) => result.status === "interrupted");
      if (interrupted) return interrupted;
      return settled.value[0] ?? { status: "timeout" };
    }
    const raced =
      input.mode === "any" || waits.length > 1
        ? Effect.raceAll(waits)
        : (waits[0] as Effect.Effect<SubagentWaitResponseDto>);
    const result = yield* raced.pipe(Effect.timeoutOption(longPollMs()));
    return result._tag === "None" ? { status: "timeout" } : result.value;
  });
