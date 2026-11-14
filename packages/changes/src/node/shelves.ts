/** File-backed shelves: `<change dir>/shelves/<repository>/<stamp>-<slug>/{shelf.json,changes.patch}`.
 * The directory is found the way the record is — each pair's active root, then each archive — so a
 * change's shelves travel into the archive and back with it. */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"

import type { ChangeId, DirectoryName } from "@corvi/contracts/changes"
import { AbsolutePath } from "@corvi/contracts/paths"
import { ShelfId, ShelfSchema, type ShelfDto } from "@corvi/contracts/shelves"
import { ChangeFormatTooNew, ChangeNotFound, ChangeStoreError, ShelfNotFound } from "../errors.ts"
import { FORMAT_VERSION } from "../record.ts"
import { ShelfStore } from "../shelves.ts"
import type { RootPair } from "./store.ts"

const SHELVES = "shelves"
const DESCRIPTION = "shelf.json"
const PATCH = "changes.patch"

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT"

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** A name as a directory-safe slug, bounded so the path stays short. */
const slugOf = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

/** A sortable instant for a directory name: `20261112T101500123Z`. */
const stampOf = (date: Date): string => date.toISOString().replace(/[-:.]/g, "")

export const layer = (options: { readonly roots: readonly RootPair[] }): Layer.Layer<ShelfStore> =>
  Layer.succeed(ShelfStore, (() => {
    const fs = <A>(
      changeId: ChangeId,
      operation: "read" | "write",
      what: string,
      work: () => Promise<A>,
    ): Effect.Effect<A, ChangeStoreError> =>
      Effect.tryPromise({
        try: work,
        catch: (cause) =>
          new ChangeStoreError({ changeId, operation, message: `${what}: ${describe(cause)}`, cause }),
      })

    /** The change's directory and its record's format, or undefined when no scope holds it. */
    const locate = (
      changeId: ChangeId,
    ): Effect.Effect<{ readonly dir: string; readonly format: number } | undefined, ChangeStoreError> =>
      Effect.gen(function* () {
        const candidates = [
          ...options.roots.map(({ root }) => join(root, changeId)),
          ...options.roots.map(({ archiveRoot }) => join(archiveRoot, changeId)),
        ]
        for (const dir of candidates) {
          const text = yield* fs(changeId, "read", `could not read ${join(dir, "change.json")}`, () =>
            readFile(join(dir, "change.json"), "utf8"),
          ).pipe(
            Effect.catchTag("ChangeStoreError", (error) =>
              isNotFound(error.cause) ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          )
          if (text === undefined) continue
          const format = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(text).pipe(
            Effect.map((raw) => (typeof raw.formatVersion === "number" ? raw.formatVersion : 1)),
            Effect.orElseSucceed(() => 1),
          )
          return { dir, format }
        }
        return undefined
      })

    /** The change's directory for a write: it must exist, and be one this version may write. */
    const writableDir = (changeId: ChangeId): Effect.Effect<string, ChangeNotFound | ChangeFormatTooNew | ChangeStoreError> =>
      Effect.gen(function* () {
        const found = yield* locate(changeId)
        if (!found) return yield* new ChangeNotFound({ changeId, message: `change ${changeId} was not found` })
        if (found.format > FORMAT_VERSION)
          return yield* new ChangeFormatTooNew({
            changeId,
            recordFormat: found.format,
            appFormat: FORMAT_VERSION,
            message:
              `change ${changeId} was written by a newer version of Corvi ` +
              `(record format ${found.format}, this one writes ${FORMAT_VERSION}); upgrade to edit it`,
          })
        return found.dir
      })

    /** A shelf's directory, confined to the change's `shelves/`: an id that escapes it names no shelf. */
    const shelfDir = (dir: string, shelfId: string): string | undefined => {
      const base = join(dir, SHELVES)
      const target = resolve(base, shelfId)
      const rel = relative(base, target)
      const parts = rel.split(/[\\/]/)
      return rel && !rel.startsWith("..") && !isAbsolute(rel) && parts.length === 2 ? target : undefined
    }

    const decodeShelf = (changeId: ChangeId, path: string, text: string): Effect.Effect<ShelfDto, ChangeStoreError> =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(ShelfSchema))(text).pipe(
        Effect.mapError(
          (cause) => new ChangeStoreError({ changeId, operation: "read", message: `malformed shelf at ${path}`, cause }),
        ),
      )

    const prepare = Effect.fn("ShelfStore.prepare")(function* (input: {
      readonly changeId: ChangeId
      readonly repository: DirectoryName
      readonly name: string
    }) {
      const dir = yield* writableDir(input.changeId)
      const slug = slugOf(input.name)
      const stamp = stampOf(new Date())
      for (let attempt = 1; ; attempt++) {
        const leaf = `${stamp}${slug ? `-${slug}` : ""}${attempt > 1 ? `-${attempt}` : ""}`
        const id = ShelfId.make(`${input.repository}/${leaf}`)
        const target = shelfDir(dir, id)
        if (!target)
          return yield* new ChangeStoreError({
            changeId: input.changeId,
            operation: "write",
            message: `the repository name ${input.repository} cannot name a shelf`,
          })
        // `recursive: false` on the leaf is what reserves it: two shelves in one millisecond get
        // different directories rather than one patch over the other.
        const made = yield* fs(input.changeId, "write", `could not create ${target}`, async () => {
          await mkdir(join(dir, SHELVES, input.repository), { recursive: true })
          try {
            await mkdir(target)
            return true
          } catch (cause) {
            if (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "EEXIST") return false
            throw cause
          }
        })
        if (made) return { id, patchFile: AbsolutePath.make(join(target, PATCH)) }
      }
    })

    const record = Effect.fn("ShelfStore.record")(function* (changeId: ChangeId, shelf: ShelfDto) {
      const dir = yield* writableDir(changeId).pipe(
        Effect.catchTag("ChangeNotFound", (error) =>
          Effect.fail(new ChangeStoreError({ changeId, operation: "write", message: error.message })),
        ),
      )
      const target = shelfDir(dir, shelf.id)
      if (!target)
        return yield* new ChangeStoreError({ changeId, operation: "write", message: `not a shelf id: ${shelf.id}` })
      const path = join(target, DESCRIPTION)
      const text = JSON.stringify(Schema.encodeSync(ShelfSchema)(shelf), null, 2) + "\n"
      yield* fs(changeId, "write", `could not record the shelf at ${path}`, async () => {
        await writeFile(`${path}.tmp`, text)
        await rename(`${path}.tmp`, path)
      })
    })

    const list = Effect.fn("ShelfStore.list")(function* (changeId: ChangeId) {
      const found = yield* locate(changeId)
      if (!found) return []
      const base = join(found.dir, SHELVES)
      const listDirs = (path: string): Effect.Effect<readonly string[], ChangeStoreError> =>
        fs(changeId, "read", `could not list ${path}`, async () => {
          try {
            const entries = await readdir(path, { withFileTypes: true })
            return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
          } catch (cause) {
            if (isNotFound(cause)) return []
            throw cause
          }
        })
      const shelves: ShelfDto[] = []
      for (const repository of yield* listDirs(base)) {
        for (const leaf of yield* listDirs(join(base, repository))) {
          const path = join(base, repository, leaf, DESCRIPTION)
          const text = yield* fs(changeId, "read", `could not read ${path}`, async () => {
            try {
              return await readFile(path, "utf8")
            } catch (cause) {
              if (isNotFound(cause)) return undefined
              throw cause
            }
          })
          // Only prepared: a capture that never finished is not a shelf.
          if (text === undefined) continue
          shelves.push(yield* decodeShelf(changeId, path, text))
        }
      }
      return shelves.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    })

    const find = Effect.fn("ShelfStore.find")(function* (changeId: ChangeId, shelfId: ShelfId) {
      const missing = new ShelfNotFound({ changeId, shelfId, message: `no shelf ${shelfId} in ${changeId}` })
      const found = yield* locate(changeId)
      const target = found ? shelfDir(found.dir, shelfId) : undefined
      if (!target) return yield* missing
      const path = join(target, DESCRIPTION)
      const text = yield* fs(changeId, "read", `could not read ${path}`, async () => {
        try {
          return await readFile(path, "utf8")
        } catch (cause) {
          if (isNotFound(cause)) return undefined
          throw cause
        }
      })
      if (text === undefined) return yield* missing
      const shelf = yield* decodeShelf(changeId, path, text)
      return { shelf, patchFile: AbsolutePath.make(join(target, PATCH)) }
    })

    const readPatch = Effect.fn("ShelfStore.readPatch")(function* (changeId: ChangeId, shelfId: ShelfId) {
      const { patchFile } = yield* find(changeId, shelfId)
      return yield* fs(changeId, "read", `could not read ${patchFile}`, () => readFile(patchFile, "utf8"))
    })

    const remove = Effect.fn("ShelfStore.remove")(function* (changeId: ChangeId, shelfId: ShelfId) {
      const found = yield* locate(changeId)
      if (!found) return
      if (found.format > FORMAT_VERSION)
        return yield* new ChangeFormatTooNew({
          changeId,
          recordFormat: found.format,
          appFormat: FORMAT_VERSION,
          message:
            `change ${changeId} was written by a newer version of Corvi ` +
            `(record format ${found.format}, this one writes ${FORMAT_VERSION}); upgrade to edit it`,
        })
      const target = shelfDir(found.dir, shelfId)
      if (!target) return
      yield* fs(changeId, "write", `could not remove ${target}`, () => rm(target, { recursive: true, force: true }))
    })

    return { prepare, record, list, find, readPatch, remove }
  })())
