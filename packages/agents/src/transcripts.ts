/** Agent transcripts: where a harness keeps the sessions an agent ran, and what one of them says.
 *
 * The harness knowledge is data and pure functions here — pi's session directory naming, its
 * JSONL entries, opencode's export — so it is tested without a filesystem. The `AgentTranscripts`
 * port copies and reads them; its file-system half is `@corvi/agents/node`. A copy is the raw
 * file, untouched: the rendering below is for reading, the copy is what a later review uses.
 */
import { Context, Schema, type Effect } from "effect"

import { trimTrailingSeparators, type AbsolutePath } from "@corvi/contracts/paths"
import type {
  TranscriptDto,
  TranscriptEntryDto,
  TranscriptHarness,
  TranscriptSummaryDto,
} from "@corvi/contracts/transcripts"

export class TranscriptError extends Schema.TaggedError<TranscriptError>()("TranscriptError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class TranscriptNotFound extends Schema.TaggedError<TranscriptNotFound>()("TranscriptNotFound", {
  id: Schema.String,
  message: Schema.String,
}) {}

/** What a collection copied: how many sessions, and per harness why it found nothing when it
 * could not look (not installed, unreadable) — a harness with no sessions says nothing. */
export type CollectedTranscripts = {
  readonly copied: number
  readonly notes: readonly string[]
}

export interface AgentTranscriptsInterface {
  /** Copy every session an agent ran in `from` or below it into `to`, replacing earlier copies of
   * the same sessions. A session belongs to `from` by the directory it says it ran in, never by
   * its file's name alone. The harnesses' own stores are only read. */
  readonly collect: (input: {
    readonly from: AbsolutePath
    readonly to: AbsolutePath
  }) => Effect.Effect<CollectedTranscripts, TranscriptError>
  /** The copies kept in `dir` (a change's `transcripts/`), newest first. A directory that is not
   * there holds none. */
  readonly list: (dir: AbsolutePath) => Effect.Effect<readonly TranscriptSummaryDto[], TranscriptError>
  /** One copy, read for display. */
  readonly read: (
    dir: AbsolutePath,
    id: string,
  ) => Effect.Effect<TranscriptDto, TranscriptError | TranscriptNotFound>
}

export class AgentTranscripts extends Context.Service<AgentTranscripts, AgentTranscriptsInterface>()(
  "corvi/AgentTranscripts",
) {}

/** The directory a change keeps its copies in. */
export const TRANSCRIPTS_DIRECTORY = "transcripts"

/** Tool output longer than this is shortened for reading; the copy keeps all of it. */
export const OUTPUT_LIMIT = 20_000

/** pi's directory for the sessions of one working directory: the leading separator dropped, `/`,
 * `\` and `:` turned into `-`, wrapped in `--` (docs/session-format.md of pi). */
export const piSessionDirectoryName = (cwd: string): string =>
  `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`

/** The prefix every session directory of `dir` and of anything below it starts with. A prefix
 * alone also matches `dir-more`; the session's own header decides. */
export const piSessionDirectoryPrefix = (dir: string): string => piSessionDirectoryName(dir).slice(0, -2)

/** Whether `path` is `dir` or inside it, by path components. */
export const isWithin = (dir: string, path: string): boolean => {
  const base = trimTrailingSeparators(dir)
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
}

/** `path` relative to `dir`, `/`-separated; empty for `dir` itself. */
export const relativeWithin = (dir: string, path: string): string =>
  path === dir ? "" : path.slice(trimTrailingSeparators(dir).length + 1).replaceAll("\\", "/")

export type PiSessionHeader = {
  readonly id: string
  readonly cwd: string
  readonly timestamp?: string
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const parseLine = (line: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return undefined
  }
}

/** A pi session file's first line, when it is a session header with a working directory. */
export const parsePiHeader = (firstLine: string): PiSessionHeader | undefined => {
  const entry = parseLine(firstLine)
  if (entry?.type !== "session") return undefined
  const id = asString(entry.id)
  const cwd = asString(entry.cwd)
  if (!id || !cwd) return undefined
  const timestamp = asString(entry.timestamp)
  return { id, cwd, ...(timestamp ? { timestamp } : {}) }
}

const shorten = (text: string): string =>
  text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} more characters in the copy)`
    : text

/** The text of a content value: a string, or text blocks joined; images say so. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      const part = asRecord(block)
      if (part?.type === "text") return asString(part.text) ?? ""
      if (part?.type === "image") return "[image]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}

const at = (timestamp: unknown): { at?: string } => {
  if (typeof timestamp === "string") return { at: timestamp }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return { at: new Date(timestamp).toISOString() }
  return {}
}

/** One pi message as entries. */
const piMessageEntries = (message: Record<string, unknown>, when: { at?: string }): TranscriptEntryDto[] => {
  switch (message.role) {
    case "user": {
      const text = textOf(message.content)
      return text ? [{ _tag: "Message", role: "user", text, ...when }] : []
    }
    case "assistant": {
      const entries: TranscriptEntryDto[] = []
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const part = asRecord(block)
        if (part?.type === "text" && asString(part.text)) entries.push({ _tag: "Message", role: "assistant", text: String(part.text), ...when })
        else if (part?.type === "thinking" && asString(part.thinking)) entries.push({ _tag: "Thinking", text: String(part.thinking), ...when })
        else if (part?.type === "toolCall")
          entries.push({ _tag: "ToolCall", name: asString(part.name) ?? "tool", input: json(part.arguments), ...when })
      }
      const error = asString(message.errorMessage)
      if (error) entries.push({ _tag: "Note", text: `error: ${error}`, ...when })
      return entries
    }
    case "toolResult":
      return [
        {
          _tag: "ToolResult",
          name: asString(message.toolName) ?? "tool",
          output: shorten(textOf(message.content)),
          error: message.isError === true,
          ...when,
        },
      ]
    case "system": {
      // The opening system message is the harness's own prompt, the same in every session.
      const text = textOf(message.content)
      return text ? [{ _tag: "Message", role: "system", text, ...when }] : []
    }
    case "bashExecution":
      return [
        { _tag: "ToolCall", name: "shell", input: asString(message.command) ?? "", ...when },
        { _tag: "ToolResult", name: "shell", output: shorten(asString(message.output) ?? ""), error: false, ...when },
      ]
    case "custom": {
      const text = textOf(message.content)
      return text && message.display !== false ? [{ _tag: "Note", text, ...when }] : []
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = asString(message.summary)
      return summary ? [{ _tag: "Note", text: summary, ...when }] : []
    }
    default:
      return []
  }
}

/** A pi session file (JSONL), read for display. Entries are in file order; a line that does not
 * parse is skipped rather than failing the whole conversation. */
export const parsePiSession = (
  text: string,
  meta: { readonly id: string; readonly where: string },
): TranscriptDto => {
  const lines = text.split("\n").filter((line) => line.trim())
  const header = lines[0] ? parsePiHeader(lines[0]) : undefined
  const entries: TranscriptEntryDto[] = []
  let title: string | undefined
  let firstUser: string | undefined
  for (const line of lines.slice(header ? 1 : 0)) {
    const entry = parseLine(line)
    if (!entry) continue
    const when = at(entry.timestamp)
    switch (entry.type) {
      case "session_info":
        title = asString(entry.name) ?? title
        break
      case "model_change":
        entries.push({ _tag: "Note", text: `model: ${asString(entry.provider) ?? "?"}/${asString(entry.modelId) ?? "?"}`, ...when })
        break
      case "compaction": {
        const summary = asString(entry.summary)
        if (summary) entries.push({ _tag: "Note", text: `compacted:\n${summary}`, ...when })
        break
      }
      case "message": {
        const message = asRecord(entry.message)
        if (!message) break
        const produced = piMessageEntries(message, when)
        if (!firstUser && message.role === "user") firstUser = produced.find((one) => one._tag === "Message")?.text
        entries.push(...produced)
        break
      }
    }
  }
  const summaryTitle = title ?? (firstUser ? firstUser.split("\n")[0]?.slice(0, 100) : undefined)
  const summary: TranscriptSummaryDto = {
    id: meta.id,
    harness: "pi",
    sessionId: header?.id ?? meta.id,
    cwd: header?.cwd ?? "",
    where: meta.where,
    ...(summaryTitle ? { title: summaryTitle } : {}),
    ...(header?.timestamp ? { startedAt: header.timestamp } : {}),
    entries: entries.length,
  }
  return { summary, entries }
}

/** An opencode session export (`opencode session export <id>`), read for display. The export's
 * parts vary by opencode version, so anything not recognised is a note rather than an error. */
export const parseOpencodeExport = (
  text: string,
  meta: { readonly id: string; readonly where: string },
): TranscriptDto => {
  const parsed = parseLine(text.trim()) ?? {}
  const info = asRecord(parsed.info) ?? {}
  const location = asRecord(info.location) ?? {}
  const time = asRecord(info.time) ?? {}
  const entries: TranscriptEntryDto[] = []
  for (const raw of Array.isArray(parsed.messages) ? parsed.messages : []) {
    const message = asRecord(raw)
    if (!message) continue
    const when = at(asRecord(message.time)?.created)
    const role = asString(message.type) ?? asString(message.role)
    if (role === "user") {
      const text = asString(message.text) ?? textOf(message.content)
      if (text) entries.push({ _tag: "Message", role: "user", text, ...when })
      continue
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const part = asRecord(block)
      if (!part) continue
      const kind = asString(part.type)
      if (kind === "text" && asString(part.text)) entries.push({ _tag: "Message", role: "assistant", text: String(part.text), ...when })
      else if ((kind === "reasoning" || kind === "thinking") && asString(part.text ?? part.thinking))
        entries.push({ _tag: "Thinking", text: String(part.text ?? part.thinking), ...when })
      else if (kind === "tool" || kind === "tool-call" || kind === "toolCall") {
        const state = asRecord(part.state) ?? {}
        const name = asString(part.tool) ?? asString(part.name) ?? "tool"
        entries.push({ _tag: "ToolCall", name, input: json(state.input ?? part.input ?? part.arguments), ...when })
        const output = state.output ?? part.output
        if (output !== undefined)
          entries.push({
            _tag: "ToolResult",
            name,
            output: shorten(typeof output === "string" ? output : json(output)),
            error: state.status === "error",
            ...when,
          })
      } else if (kind) entries.push({ _tag: "Note", text: `${kind}: ${shorten(json(part))}`, ...when })
    }
  }
  const created = at(time.created)
  const title = asString(info.title)
  const summary: TranscriptSummaryDto = {
    id: meta.id,
    harness: "opencode",
    sessionId: asString(info.id) ?? meta.id,
    cwd: asString(location.directory) ?? asString(info.directory) ?? "",
    where: meta.where,
    ...(title ? { title } : {}),
    ...(created.at ? { startedAt: created.at } : {}),
    entries: entries.length,
  }
  return { summary, entries }
}

/** Which harness a copy belongs to, by the directory the collection files it under. */
export const harnessOfCopy = (id: string): TranscriptHarness | undefined => {
  const first = id.split("/")[0]
  return first === "pi" || first === "opencode" ? first : undefined
}

/** Where a copy's session ran, relative to the change: the directories between the harness's
 * folder and the file. */
export const whereOfCopy = (id: string): string => id.split("/").slice(1, -1).join("/")
