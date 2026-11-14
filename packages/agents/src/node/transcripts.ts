/** The file-system half of agent transcripts: where pi and opencode keep sessions on this machine,
 * copying the ones that ran in a change, and reading the copies back.
 *
 * pi is read straight from its session files (`~/.pi/agent/sessions/--<path>--/*.jsonl`, or
 * wherever its settings moved them); opencode only through its own CLI, never its database. Both
 * stores are only read: a copy is a copy, and the harness keeps resuming its own sessions. */
import { spawn } from "node:child_process"
import { copyFile, mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Layer } from "effect"

import type { TranscriptSummaryDto } from "@corvi/contracts/transcripts"
import {
  AgentTranscripts,
  TranscriptError,
  TranscriptNotFound,
  harnessOfCopy,
  isWithin,
  parseOpencodeExport,
  parsePiHeader,
  parsePiSession,
  piSessionDirectoryPrefix,
  relativeWithin,
  whereOfCopy,
  type CollectedTranscripts,
} from "../transcripts.ts"

/** How opencode is asked about its sessions. The node implementation runs its CLI; tests script it. */
export type OpencodeCli = {
  /** `opencode session list --format json`, run in `cwd`. Undefined when opencode is not installed. */
  readonly listSessions: (cwd: string) => Effect.Effect<string | undefined, TranscriptError>
  /** `opencode session export <id>`: the session as JSON. */
  readonly exportSession: (id: string) => Effect.Effect<string, TranscriptError>
}

/** No CLI call here waits longer: a hung opencode must not hold an archive step forever. */
const OPENCODE_TIMEOUT_MS = 60_000

const runOpencode = (
  args: readonly string[],
  cwd: string,
): Effect.Effect<{ readonly code: number; readonly stdout: string } | undefined, TranscriptError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<{ readonly code: number; readonly stdout: string } | undefined>((resolvePromise, reject) => {
        // `--standalone`: a private server for this one command, not the background service a
        // plain call would leave running.
        const child = spawn("opencode", [...args, "--standalone"], { cwd, stdio: ["ignore", "pipe", "pipe"] })
        let stdout = ""
        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk
        })
        child.stderr.resume()
        const timer = setTimeout(() => child.kill("SIGTERM"), OPENCODE_TIMEOUT_MS)
        child.on("error", (cause: NodeJS.ErrnoException) => {
          clearTimeout(timer)
          if (cause.code === "ENOENT") resolvePromise(undefined)
          else reject(cause)
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          resolvePromise({ code: code ?? -1, stdout })
        })
      }),
    catch: (cause) => new TranscriptError({ message: `could not run opencode: ${describe(cause)}`, cause }),
  })

export const nodeOpencodeCli: OpencodeCli = {
  listSessions: (cwd) =>
    Effect.flatMap(runOpencode(["session", "list", "--format", "json", "--max-count", "10000"], cwd), (result) =>
      result === undefined
        ? Effect.succeed(undefined)
        : result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(new TranscriptError({ message: `opencode session list exited with ${result.code} in ${cwd}` })),
    ),
  exportSession: (id) =>
    Effect.flatMap(runOpencode(["session", "export", id], homedir()), (result) =>
      result !== undefined && result.code === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(new TranscriptError({ message: `opencode session export ${id} failed` })),
    ),
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const attempt = <A>(what: string, work: () => Promise<A>): Effect.Effect<A, TranscriptError> =>
  Effect.tryPromise({ try: work, catch: (cause) => new TranscriptError({ message: `${what}: ${describe(cause)}`, cause }) })

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"

/** A directory's entries; a directory that is not there has none. */
const entriesOf = (dir: string): Effect.Effect<readonly { readonly name: string; readonly directory: boolean }[], TranscriptError> =>
  attempt(`could not list ${dir}`, async () => {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    } catch (cause) {
      if (isMissing(cause) || (cause as { code?: unknown }).code === "ENOTDIR") return []
      throw cause
    }
  })

/** A file's first line, read without loading a session of megabytes. */
const firstLineOf = (path: string): Effect.Effect<string, TranscriptError> =>
  attempt(`could not read ${path}`, async () => {
    const handle = await open(path, "r")
    try {
      const chunks: Buffer[] = []
      const buffer = Buffer.alloc(64 * 1024)
      for (let position = 0; position < 4 * 1024 * 1024; ) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)
        const newline = chunk.indexOf(10)
        if (newline >= 0) {
          chunks.push(Buffer.from(chunk.subarray(0, newline)))
          break
        }
        chunks.push(Buffer.from(chunk))
        position += bytesRead
      }
      return Buffer.concat(chunks).toString("utf8")
    } finally {
      await handle.close()
    }
  })

/** Where pi keeps sessions on this machine, every place its configuration can name — in pi's own
 * order of precedence, all of them, since sessions written under an earlier configuration are still
 * there: `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting, then the agent directory's
 * `sessions/` (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). `--session-dir` on one run cannot be
 * known afterwards. */
export const piSessionRoots = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const expand = (path: string): string => (path.startsWith("~") ? join(home, path.slice(1)) : path)
    const agentDir = expand(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"))
    const settings = yield* attempt("could not read pi's settings", () =>
      readFile(join(agentDir, "settings.json"), "utf8"),
    ).pipe(Effect.orElseSucceed(() => ""))
    const configured = (() => {
      try {
        const parsed: unknown = JSON.parse(settings)
        const value = typeof parsed === "object" && parsed !== null ? (parsed as { sessionDir?: unknown }).sessionDir : undefined
        // A relative `sessionDir` resolves from wherever pi was started, which nothing records.
        return typeof value === "string" && isAbsolute(expand(value)) ? expand(value) : undefined
      } catch {
        return undefined
      }
    })()
    const roots = [env.PI_CODING_AGENT_SESSION_DIR ? expand(env.PI_CODING_AGENT_SESSION_DIR) : undefined, configured, join(agentDir, "sessions")]
    return [...new Set(roots.filter((root): root is string => Boolean(root)))]
  })

/** Where opencode keeps its sessions, by its own environment: `OPENCODE_DB`, else its data
 * directory's `opencode/opencode.db`. */
export const opencodeDatabase = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string => env.OPENCODE_DB || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "opencode.db")

/** opencode's CLI when opencode has ever stored a session here, and nothing otherwise: an
 * opencode that has no database has nothing to be asked about, and is not started for it. */
export const opencodeIfUsed = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): Effect.Effect<OpencodeCli | undefined> =>
  attempt("", () => stat(opencodeDatabase(env, home))).pipe(
    Effect.map((): OpencodeCli | undefined => nodeOpencodeCli),
    Effect.orElseSucceed(() => undefined),
  )

export const transcriptsLayer = (options: {
  readonly piSessionRoots: readonly string[]
  readonly opencode?: OpencodeCli
}): Layer.Layer<AgentTranscripts> =>
  Layer.succeed(AgentTranscripts, {
    collect: ({ from, to }) =>
      Effect.gen(function* () {
        // The directory as configured, and as the OS reports it: an agent records the path its
        // process saw, which is the real one when the configured root goes through a symlink.
        const real = yield* attempt("", () => realpath(from)).pipe(Effect.orElseSucceed(() => undefined))
        const bases = [...new Set([String(from), ...(real ? [real] : [])])]
        const baseOf = (cwd: string): string | undefined => bases.find((base) => isWithin(base, cwd))
        const inCopies = (cwd: string): boolean => isWithin(to, cwd)
        let copied = 0
        const notes: string[] = []

        const copyInto = (source: string, harness: string, where: string, name: string): Effect.Effect<void, TranscriptError> =>
          attempt(`could not copy ${source}`, async () => {
            const target = join(to, harness, where, name)
            await mkdir(join(to, harness, where), { recursive: true })
            await copyFile(source, target)
          })

        // pi: the session directories named after `from` or something below it, each session
        // confirmed by the working directory its header records.
        const prefixes = bases.map(piSessionDirectoryPrefix)
        const piCopy = (path: string): Effect.Effect<void, TranscriptError> =>
          Effect.gen(function* () {
            const header = parsePiHeader(yield* firstLineOf(path))
            if (!header) return
            const base = baseOf(header.cwd)
            if (base === undefined || inCopies(header.cwd)) return
            yield* copyInto(path, "pi", relativeWithin(base, header.cwd), basename(path))
            copied += 1
          })
        for (const root of options.piSessionRoots) {
          for (const entry of yield* entriesOf(root)) {
            if (!entry.directory) {
              // A `sessionDir` that is not grouped by directory keeps the files right here.
              if (entry.name.endsWith(".jsonl")) yield* piCopy(join(root, entry.name))
              continue
            }
            if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue
            for (const file of yield* entriesOf(join(root, entry.name))) {
              if (!file.directory && file.name.endsWith(".jsonl")) yield* piCopy(join(root, entry.name, file.name))
            }
          }
        }

        // opencode: asked per directory an agent could have run in — the change, its checkouts and
        // its subagents — and every session confirmed by the directory its export records.
        const cli = options.opencode
        if (cli) {
          const top = yield* entriesOf(from)
          const subagents = yield* entriesOf(join(from, "subagents"))
          const places = [
            String(from),
            ...top.filter((entry) => entry.directory && join(from, entry.name) !== String(to)).map((entry) => join(from, entry.name)),
            ...subagents.filter((entry) => entry.directory).map((entry) => join(from, "subagents", entry.name)),
          ]
          const seen = new Set<string>()
          // A directory that is gone (a backfill of an old archive) has nobody to ask.
          for (const place of top.length === 0 ? [] : places) {
            const answer = yield* cli.listSessions(place).pipe(Effect.result)
            if (answer._tag === "Failure") {
              notes.push(answer.failure.message)
              continue
            }
            const listed = answer.success
            if (listed === undefined) {
              notes.push("opencode is not installed")
              break
            }
            const ids = (() => {
              try {
                const parsed: unknown = JSON.parse(listed)
                return Array.isArray(parsed)
                  ? parsed.flatMap((item: unknown) => {
                      const id = typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined
                      return typeof id === "string" ? [id] : []
                    })
                  : []
              } catch {
                return []
              }
            })()
            for (const id of ids) {
              if (seen.has(id)) continue
              seen.add(id)
              const exportedAnswer = yield* cli.exportSession(id).pipe(Effect.result)
              if (exportedAnswer._tag === "Failure") {
                notes.push(exportedAnswer.failure.message)
                continue
              }
              const exported = exportedAnswer.success
              const cwd = parseOpencodeExport(exported, { id, where: "" }).summary.cwd
              const base = baseOf(cwd)
              if (base === undefined || inCopies(cwd)) continue
              const where = relativeWithin(base, cwd)
              yield* attempt(`could not write the opencode session ${id}`, async () => {
                await mkdir(join(to, "opencode", where), { recursive: true })
                await writeFile(join(to, "opencode", where, `${id}.json`), exported)
              })
              copied += 1
            }
          }
        }
        return { copied, notes } satisfies CollectedTranscripts
      }),

    list: (dir) =>
      Effect.gen(function* () {
        const summaries: TranscriptSummaryDto[] = []
        const walk = (path: string, prefix: string): Effect.Effect<void, TranscriptError> =>
          Effect.gen(function* () {
            for (const entry of yield* entriesOf(path)) {
              const id = prefix ? `${prefix}/${entry.name}` : entry.name
              if (entry.directory) {
                yield* walk(join(path, entry.name), id)
                continue
              }
              const harness = harnessOfCopy(id)
              if (harness === "pi" && entry.name.endsWith(".jsonl")) {
                const text = yield* attempt(`could not read ${id}`, () => readFile(join(path, entry.name), "utf8"))
                summaries.push(parsePiSession(text, { id, where: whereOfCopy(id) }).summary)
              } else if (harness === "opencode" && entry.name.endsWith(".json")) {
                const text = yield* attempt(`could not read ${id}`, () => readFile(join(path, entry.name), "utf8"))
                summaries.push(parseOpencodeExport(text, { id, where: whereOfCopy(id) }).summary)
              }
            }
          })
        yield* walk(dir, "")
        return summaries.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
      }),

    read: (dir, id) =>
      Effect.gen(function* () {
        const missing = new TranscriptNotFound({ id, message: `no transcript ${id}` })
        const target = resolve(dir, id)
        const rel = relative(dir, target)
        const harness = harnessOfCopy(id)
        if (!rel || rel.startsWith("..") || isAbsolute(rel) || harness === undefined) return yield* missing
        const text = yield* attempt(`could not read ${id}`, async () => {
          try {
            return await readFile(target, "utf8")
          } catch (cause) {
            if (isMissing(cause)) return undefined
            throw cause
          }
        })
        if (text === undefined) return yield* missing
        const meta = { id, where: whereOfCopy(id) }
        return harness === "pi" ? parsePiSession(text, meta) : parseOpencodeExport(text, meta)
      }),
  })
