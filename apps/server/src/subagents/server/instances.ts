/**
 * Subagent instances: create, open, close, message, and wait.
 *
 * Composes three things: the instance store (`@corvi/agents/node`, one directory per subagent),
 * the terminal (`@corvi/terminals`, one tmux window per attached subagent), and the waiter
 * registry (`./waiters.ts`, the long poll's parking lot). The server is the single writer of the
 * `session.json` records and the message files; **every** read-modify-write of a record goes
 * through the store's per-subagent lock (`mutateRecord`/`appendMessageAndPatch`/`claimInbound`),
 * so two concurrent requests cannot interleave a cursor, an in-flight marker, or a log.
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
  appendMessageAndPatch,
  claimInbound,
  createInstance,
  findCreatedByKey,
  instanceDir,
  readInstance,
  listInstances,
  mutateRecord,
  removeInstance,
  writeRecord,
  withCreateLock,
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
import { notify, subscribe } from "./waiters.ts";

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

const toDto = (record: SubagentWithMessages, live: Live | undefined): SubagentInstanceDto => {
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
    const slug =
      label
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

/** How an instance's window is opened. The default creates the tmux window and returns its id;
 * a test can supply one that returns a fake id, which is the only part of create/open that
 * touches tmux. The caller persists the id under the lock. */
export type SubagentLauncher = (change: Change, record: SubagentRecord) => Effect.Effect<string, BadRequestError>;

const startWindow: SubagentLauncher = (change, record) =>
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
    return window;
  });

const opened = (change: Change, id: string, window: string): Effect.Effect<void, BadRequestError> =>
  mutateRecord(changeDir(change), id, (record) => ({
    write: true,
    record: { ...record, window, log: [...record.log, { kind: "opened", at: now() }] },
    result: undefined,
  })).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));

/** Create a subagent from a profile, open its window, and (when a task was given) append the
 * initial inbound message. Create, open and the first message are bound on purpose. A failed
 * launcher rolls the whole instance back, and a retried create with the same idempotency key
 * returns the instance it already made. */
export const createSubagent = (
  change: Change,
  input: SubagentCreateRequestDto,
  launcher: SubagentLauncher = startWindow,
  key?: string,
): Effect.Effect<SubagentInstanceDto, BadRequestError | ConflictError | NotFoundError> =>
  Effect.gen(function* () {
    if (change.completedAt) {
      return yield* new BadRequestError({ message: "this change is finished: no new subagents" });
    }
    if (key !== undefined) {
      const existing = yield* findCreatedByKey(changeDir(change), key).pipe(
        Effect.mapError((error) => new BadRequestError({ message: error.message })),
      );
      if (existing) return toDto(existing, undefined);
    }
    const profile = yield* resolveProfileFor(change, input.profile);
    if (!profile) {
      return yield* new BadRequestError({ message: `no such profile: ${input.profile}` });
    }
    const from = input.from ?? "orchestrator";
    const dir = changeDir(change);
    return yield* withCreateLock(
      dir,
      Effect.gen(function* () {
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
          ...(key === undefined ? {} : { createdKey: key }),
          log: [{ kind: "created", at: now() }],
        };
        yield* createInstance(dir, record).pipe(
          Effect.mapError(() => new ConflictError({ message: `subagent "${id}" already exists` })),
        );
        if (input.prompt !== undefined && input.prompt !== "") {
          yield* appendMessageAndPatch(
            dir,
            id,
            { role: from, body: input.prompt, at: now() },
            (current) => current,
          ).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));
        }
        // The launcher can still fail after the files exist: roll back so a failed create leaves
        // nothing behind, and a retry starts clean.
        const window = yield* launcher(change, record).pipe(
          Effect.catchAll((failure) => Effect.zipRight(removeInstance(dir, id), Effect.fail(failure))),
        );
        yield* opened(change, id, window);
        return yield* refreshSubagent(change, id);
      }),
    );
  });

export const openSubagent = (
  change: Change,
  id: string,
  launcher: SubagentLauncher = startWindow,
): Effect.Effect<SubagentInstanceDto, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    const live = (yield* liveBySubagent(change.id)).get(id);
    if (live !== undefined) return toDto(record, live);
    const window = yield* launcher(change, record);
    yield* opened(change, id, window);
    yield* Effect.sync(() => announce("windows"));
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
    yield* mutateRecord(changeDir(change), id, (current) => ({
      write: true,
      record: {
        ...current,
        window: undefined,
        log: [...current.log, { kind: "closed", at: now() }],
      },
      result: undefined,
    })).pipe(Effect.catchAll(() => Effect.void));
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
  key?: string,
): Effect.Effect<SubagentMessage, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    yield* requireInstance(change, id);
    const { message } = yield* appendMessageAndPatch(
      changeDir(change),
      id,
      { role: from, body: text, at: now(), ...(key === undefined ? {} : { key }) },
      (record) =>
        record.inFlight === undefined
          ? { ...record }
          : {
              ...record,
              inFlight: undefined,
              log: [...record.log, { kind: "continued", at: now(), note: "a new message arrived" }],
            },
    ).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));
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
  key?: string,
  pane?: string,
): Effect.Effect<SubagentMessage, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    yield* requireInstance(change, id);
    const { message } = yield* appendMessageAndPatch(
      changeDir(change),
      id,
      {
        role: "subagent",
        body: text,
        at: now(),
        ...(key === undefined ? {} : { key }),
        ...(pane === undefined ? {} : { pane }),
      },
      (record) =>
        record.inFlight === undefined
          ? { ...record }
          : {
              ...record,
              inFlight: undefined,
              log: [...record.log, { kind: "turn_settled", at: now() }],
            },
    ).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));
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

/** The extension's half: the next message to submit, an interrupted turn to leave alone, or
 * nothing yet. `after` is the last message number the caller already submitted; a live extension
 * that lost the response can be handed that message again, while a fresh extension (no `after`)
 * gets `interrupted` rather than a redelivery. */
export const nextForSubagent = (
  change: Change,
  id: string,
  after?: number,
): Effect.Effect<SubagentNextResponseDto, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    yield* requireInstance(change, id);
    const deadline = Date.now() + longPollMs();
    for (;;) {
      // Subscribe before reading, and keep the subscription until the step settles: an event that
      // fires after the registration resolves the deferred; one that fired before is seen by the
      // claim below.
      const subscription = yield* subscribe(change.id, id);
      const step = yield* Effect.gen(function* () {
        const claimed = yield* claimInbound(changeDir(change), id, now(), after).pipe(
          Effect.mapError((error) => new BadRequestError({ message: error.message })),
        );
        if (claimed.status === "message") {
          return { done: true as const, result: { status: "message" as const, message: claimed.message } };
        }
        if (claimed.status === "interrupted") {
          return { done: true as const, result: { status: "interrupted" as const } };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { done: true as const, result: { status: "none" as const } };
        const event = yield* subscription.await.pipe(Effect.timeoutOption(remaining));
        if (event._tag === "None") {
          return { done: true as const, result: { status: "none" as const } };
        }
        if (event.value.kind === "interrupted" || event.value.kind === "lost") {
          return { done: true as const, result: { status: "interrupted" as const } };
        }
        return { done: false as const };
      }).pipe(Effect.ensuring(subscription.close));
      if (step.done) return step.result;
      // inbound or reply: loop, claim, and either return the message or park again.
    }
  });

/** The latest subagent message with a number above the token, if one is already there. */
const deliveredSince = (record: SubagentWithMessages, token: number): SubagentMessage | undefined =>
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
    // before the wait does not resolve it. `--since` overrides the baseline.
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
          const live = yield* liveBySubagent(change.id);
          const attached = live.has(id);
          // Subscribe before reading, and keep the subscription until the step settles.
          const subscription = yield* subscribe(change.id, id);
          const step = yield* Effect.gen(function* () {
            const record = yield* requireInstance(change, id).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            );
            if (record === null) {
              return { done: true as const, result: { status: "lost" as const, id } };
            }
            // In flight with no live window: the machine was interrupted mid-turn.
            if (record.inFlight !== undefined && !attached) {
              return { done: true as const, result: { status: "interrupted" as const, id } };
            }
            const delivered = deliveredSince(record, baseline.get(id) ?? 0);
            if (delivered) {
              return { done: true as const, result: { status: "turn" as const, id, message: delivered } };
            }
            const event = yield* subscription.await;
            if (event.kind === "reply") {
              return { done: true as const, result: { status: "turn" as const, id, message: event.message } };
            }
            if (event.kind === "lost") return { done: true as const, result: { status: "lost" as const, id } };
            if (event.kind === "interrupted") {
              return { done: true as const, result: { status: "interrupted" as const, id } };
            }
            return { done: false as const };
          }).pipe(Effect.ensuring(subscription.close));
          if (step.done) return step.result;
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
