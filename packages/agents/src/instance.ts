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
 * reporter. `interrupted` is exactly "in flight and no live window". */
import { Either, Schema } from "effect";

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
  /** The latest message is the subagent's: a reply is waiting for the orchestrator. */
  readonly awaitingReply: boolean;
};

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
  return {
    presence: live.attached ? "attached" : "detached",
    activity: working ? "working" : "idle",
    interrupted: record.inFlight !== undefined && !live.attached,
    awaitingReply: message?.role === "subagent",
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

/** One message as a file: YAML frontmatter (`from`, `at`, optional `pane`) and the body. */
export const renderMessage = (message: SubagentMessage): string => {
  const lines = [`from: ${message.role}`, `at: ${message.at}`];
  if (message.pane !== undefined) lines.push(`pane: ${message.pane}`);
  if (message.key !== undefined) lines.push(`key: ${message.key}`);
  return `---\n${lines.join("\n")}\n---\n${message.body}\n`;
};

/** Parse one message file. Total: a damaged file is a reason, not a throw. The number is left at
 * zero; the caller sets it from the filename. */
export const parseMessage = (text: string): Either.Either<SubagentMessage, readonly string[]> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return Either.left(["missing or unparseable frontmatter"]);
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const role = fields["from"];
  if (role !== "orchestrator" && role !== "user" && role !== "subagent") {
    return Either.left(["from: must be orchestrator, user or subagent"]);
  }
  if (!fields["at"]) return Either.left(["at: required"]);
  return Either.right({
    number: 0,
    role,
    at: fields["at"] ?? "",
    body: (match[2] ?? "").trim(),
    ...(fields["pane"] ? { pane: fields["pane"] } : {}),
    ...(fields["key"] ? { key: fields["key"] } : {}),
  });
};

/** Parse a `session.json` record. Total; a record from a newer Corvi still reads what it can. */
export const parseRecord = (text: string): Either.Either<SubagentRecord, readonly string[]> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Either.left(["session.json is not JSON"]);
  }
  try {
    return Either.right(Schema.decodeUnknownSync(SubagentRecordSchema)(json));
  } catch (error) {
    return Either.left([error instanceof Error ? error.message : String(error)]);
  }
};

export const renderRecord = (record: SubagentRecord & { readonly messages?: unknown }): string => {
  // Messages live in their own files; a caller that spread a record with messages must not write
  // them into `session.json`.
  const { messages: _messages, ...rest } = record;
  return JSON.stringify(rest, null, 2) + "\n";
};
