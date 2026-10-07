/** The pure half of subagent instances: number and name the message files, render and parse them,
 * and derive the view from a record, the live window, and the conversation.
 *
 * The stored shapes themselves are the wire vocabulary (`@corvi/contracts/subagents`) — the
 * server writes them and the client reads them, so there is one schema, not two. Here is what is
 * derived from them.
 *
 * State is derived, never stored, with one exception: whether a turn was in flight cannot be
 * derived after a reboot (the session and the reporter are gone), so `inFlight` is written before a
 * message is delivered and cleared when the reply settles. A claimed turn counts as working even
 * when the reporter's last published status is a stale `waiting`, so `inFlight` wins over the
 * reporter. `interrupted` is exactly "in flight and no live window".
 *
 * A reply carries `inReplyTo`, the inbound turn it answers, so readiness is judged against the
 * latest inbound turn rather than the latest message: a reply parked for an earlier turn never
 * reads as the completion of a newer one. */
import { Result, Schema } from "effect";

import {
  SubagentRecordSchema,
  type SubagentMessageDto,
  type SubagentRecordDto,
  type SubagentRole,
  type SubagentSystemEventDto,
} from "@corvi/contracts/subagents";

export type SubagentMessage = SubagentMessageDto;
export type SubagentRecord = SubagentRecordDto;
export type SubagentSystemEvent = SubagentSystemEventDto;
export type { SubagentRole };

/** A record with its messages, as the store and the list answers carry it. */
export type SubagentWithMessages = SubagentRecord & { readonly messages: readonly SubagentMessage[] };

/** Whether a live window carries this subagent. */
export type SubagentPresence = "attached" | "detached";
/** What it is doing: a turn in flight (`working`) or settled (`idle`). */
export type SubagentActivity = "idle" | "working";

export type SubagentView = {
  readonly presence: SubagentPresence;
  readonly activity: SubagentActivity;
  /** In flight with no live window: the machine was interrupted mid-turn. */
  readonly interrupted: boolean;
  /** The latest inbound turn is settled: a reply for it is parked for the orchestrator. */
  readonly awaitingReply: boolean;
};

/** The next message the relay has not picked up yet: everything the delivery cursor still holds
 * back. The one predicate `claimInbound` delivers by and the view holds readiness back by — stated
 * once, so the two cannot drift. Assumes messages are number-sorted (`readMessages` sorts them),
 * so the first undelivered inbound is also the lowest. */
export const pendingInbound = (record: SubagentWithMessages): SubagentMessage | undefined =>
  record.messages.find(
    (message) => message.role !== "subagent" && message.number > (record.deliveredThrough ?? 0),
  );

/** The highest numbered inbound message (`role !== "subagent"`), or 0 with none. Takes the max, so
 * it does not depend on the messages being number-sorted. */
export const latestInboundNumber = (messages: readonly SubagentMessage[]): number =>
  messages.reduce(
    (highest, message) =>
      message.role !== "subagent" ? Math.max(highest, message.number) : highest,
    0,
  );

/** The highest inbound message number a reply answers, counting only replies that name a turn the
 * relay actually handed over (`inReplyTo <= deliveredThrough`). A reply naming a turn that was
 * never delivered — a bogus high number, or one submitted for a turn the cursor never reached —
 * credits nothing, so it cannot pin readiness forever. Takes the max over the credited replies, so
 * it does not depend on the messages being number-sorted. */
export const answeredThrough = (
  messages: readonly SubagentMessage[],
  deliveredThrough: number,
): number =>
  messages.reduce(
    (highest, message) =>
      message.role === "subagent" &&
      message.inReplyTo !== undefined &&
      message.inReplyTo <= deliveredThrough
        ? Math.max(highest, message.inReplyTo)
        : highest,
    0,
  );

/** The highest-numbered subagent reply whose `inReplyTo` names `turn`, or undefined when none has
 * landed. A reply cannot credit a turn the relay never handed over (`turn > deliveredThrough`),
 * mirroring `answeredThrough`: a stray relay must not settle a turn that was never delivered.
 * Takes the max, so it does not depend on the messages being number-sorted. */
export const replyForTurn = (
  messages: readonly SubagentMessage[],
  turn: number,
  deliveredThrough: number,
): SubagentMessage | undefined =>
  turn > deliveredThrough
    ? undefined
    : messages.reduce<SubagentMessage | undefined>(
        (latest, message) =>
          message.role === "subagent" && message.inReplyTo === turn
            ? latest === undefined || message.number > latest.number
              ? message
              : latest
            : latest,
        undefined,
      );

/** Derive the view from a record, whether a live window carries it, and the reporter's status
 * for that window (absent when the reporter has not spoken). An in-flight turn is work even when
 * the reporter's status is a stale `waiting`: the stored claim wins over the reporter. */
export const viewOf = (
  record: SubagentRecord,
  live: { readonly attached: boolean; readonly agentStatus?: "working" | "waiting" },
  messages: readonly SubagentMessage[],
): SubagentView => {
  const message = latestMessage(messages);
  // A claimed turn is working even when the reporter's last status is stale: `inFlight` is the
  // stored fact that the relay is about to run the turn.
  const working = live.attached && (live.agentStatus === "working" || record.inFlight !== undefined);
  // A reply is parked only when the latest inbound turn is settled and nothing newer is pending.
  // `inReplyTo` is credited only for a turn the relay delivered, so an earlier reply (or a bogus
  // high attribution) cannot stand in for the latest turn; `latestInbound` includes the claimed
  // turn because claiming advances the cursor. A reply written before `inReplyTo` existed counts
  // only under the legacy rule: it is the latest message, with nothing pending and nothing in
  // flight.
  const deliveredThrough = record.deliveredThrough ?? 0;
  const pending = pendingInbound({ ...record, messages });
  const latestInbound = latestInboundNumber(messages);
  const attributedTurn = answeredThrough(messages, deliveredThrough);
  const attributed = pending === undefined && latestInbound > 0 && attributedTurn >= latestInbound;
  // The legacy rule counts only an *unattributed* reply: one that names a turn credits it under
  // `attributed`, and a reply naming a turn the relay never delivered (a bogus high number) must
  // not fall back here and be credited anyway.
  const legacy =
    message?.role === "subagent" &&
    message.inReplyTo === undefined &&
    record.inFlight === undefined &&
    pending === undefined;
  return {
    presence: live.attached ? "attached" : "detached",
    activity: working ? "working" : "idle",
    interrupted: record.inFlight !== undefined && !live.attached,
    awaitingReply: attributed || legacy,
  };
};

export const latestMessage = (
  messages: readonly SubagentMessage[],
): SubagentMessage | undefined =>
  [...messages].sort((left, right) => left.number - right.number).at(-1);

/** The next message number: one past the highest already on disk. */
export const nextNumber = (messages: readonly SubagentMessage[]): number =>
  messages.reduce((highest, message) => Math.max(highest, message.number), 0) + 1;

/** The zero-padded prefix of a message file: `007`. */
export const messagePrefix = (number: number): string => String(number).padStart(3, "0");

export const messageFileName = (number: number, role: SubagentRole): string =>
  `${messagePrefix(number)}-${role}.md`;

/** The filename back to a number and role, or undefined for a name that is not a message. */
export const messageFileOf = (
  name: string,
): { readonly number: number; readonly role: SubagentRole } | undefined => {
  const match = /^(\d+)-(orchestrator|user|subagent)\.md$/.exec(name);
  if (!match) return undefined;
  return { number: Number(match[1]), role: match[2] as SubagentRole };
};

/** One message as a file: YAML frontmatter (`from`, `at`, optional `pane`, `key`, `in_reply_to`)
 * and the body. */
export const renderMessage = (message: SubagentMessage): string => {
  const lines = [`from: ${message.role}`, `at: ${message.at}`];
  if (message.pane !== undefined) lines.push(`pane: ${message.pane}`);
  if (message.key !== undefined) lines.push(`key: ${message.key}`);
  if (message.inReplyTo !== undefined) lines.push(`in_reply_to: ${message.inReplyTo}`);
  return `---\n${lines.join("\n")}\n---\n${message.body}\n`;
};

/** Parse one message file. Total: a damaged file is a reason, not a throw. The number is left at
 * zero; the caller sets it from the filename. */
export const parseMessage = (text: string): Result.Result<SubagentMessage, readonly string[]> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return Result.fail(["missing or unparseable frontmatter"]);
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const role = fields["from"];
  if (role !== "orchestrator" && role !== "user" && role !== "subagent") {
    return Result.fail(["from: must be orchestrator, user or subagent"]);
  }
  if (!fields["at"]) return Result.fail(["at: required"]);
  // Only a plain positive message number attributes. Anything else — an empty value, `0x10`,
  // `-3`, `1.5` — is absent and falls to the legacy rule rather than becoming a number, so a
  // damaged file cannot credit a turn it does not name.
  const inReplyToRaw = fields["in_reply_to"];
  const inReplyTo =
    inReplyToRaw !== undefined && /^\d+$/.test(inReplyToRaw) && Number(inReplyToRaw) >= 1
      ? Number(inReplyToRaw)
      : undefined;
  return Result.succeed({
    number: 0,
    role,
    at: fields["at"] ?? "",
    body: (match[2] ?? "").trim(),
    ...(fields["pane"] ? { pane: fields["pane"] } : {}),
    ...(fields["key"] ? { key: fields["key"] } : {}),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  });
};

/** Parse a `session.json` record. Total; a record from a newer Corvi still reads what it can. */
export const parseRecord = (text: string): Result.Result<SubagentRecord, readonly string[]> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Result.fail(["session.json is not JSON"]);
  }
  try {
    return Result.succeed(Schema.decodeUnknownSync(SubagentRecordSchema)(json));
  } catch (error) {
    return Result.fail([error instanceof Error ? error.message : String(error)]);
  }
};

export const renderRecord = (record: SubagentRecord & { readonly messages?: unknown }): string => {
  // Messages live in their own files; a caller that spread a record with messages must not write
  // them into `session.json`.
  const { messages: _messages, ...rest } = record;
  return JSON.stringify(rest, null, 2) + "\n";
};
