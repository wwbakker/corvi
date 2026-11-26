/**
 * Files dropped or pasted into a change's terminal, stored where its ptys can read them.
 *
 * The page cannot hand a program its own machine's path: the pty may run on a remote workspace,
 * and a browser does not reveal paths at all. So the bytes are uploaded and stored in the change's
 * directory, beside its checkouts and never inside one, and the stored path is what the page
 * pastes — the same thing a native terminal pastes for a drop. The files travel with the change
 * into the archive; nothing prunes them while it is open.
 */
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Effect } from "effect";
import { BadRequestError, InternalError } from "@corvi/contracts/errors";
import { messageOf } from "../../capabilities/effect/support.ts";

/** The directory, under the change's own, that holds its terminal attachments. */
export const ATTACHMENTS_DIR = ".attachments";

/** A file name is one path segment in a listing, not a document. */
const NAME_CAP = 160;

/** How many `name-N.ext` alternatives are tried before a clash is reported. */
const MAX_SUFFIX = 999;

/** The name an upload is stored under: the last segment of what the page sent, without control
 * characters, and never `.`/`..` or empty. A name that is nothing usable becomes `attachment`. */
export const attachmentName = (raw: string): string => {
  const segment = raw.split(/[/\\]/).pop() ?? "";
  const clean = segment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean === "" || clean === "." || clean === "..") return "attachment";
  if (clean.length <= NAME_CAP) return clean;
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
  return clean.slice(0, NAME_CAP - extension.length) + extension;
};

/** The `n`th alternative for a name that is taken: `shot.png`, `shot-1.png`, `shot-2.png`. A
 * leading dot is part of the name (`.env-1`), not an extension. */
export const numberedName = (name: string, n: number): string => {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
};

const codeOf = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
const isExists = (cause: unknown): boolean => codeOf(cause) === "EEXIST";

/** Create the first free name in `dir`, exclusively, so two uploads of the same name cannot write
 * into one file. */
const createFree = async (dir: string, name: string): Promise<{ path: string; handle: FileHandle }> => {
  for (let n = 0; n <= MAX_SUFFIX; n++) {
    const path = join(dir, numberedName(name, n));
    try {
      return { path, handle: await open(path, "wx") };
    } catch (cause) {
      if (!isExists(cause)) throw cause;
    }
  }
  throw new Error(`${name} and its ${MAX_SUFFIX} numbered alternatives are all taken`);
};

/** The attachments directory, created inside a change directory that must already exist: an
 * upload racing the change's move to the archive must not recreate the directory it left, which
 * would stand in the way of reopening it. */
const attachmentsIn = async (changeDirectory: string): Promise<string> => {
  const dir = join(changeDirectory, ATTACHMENTS_DIR);
  try {
    await mkdir(dir);
  } catch (cause) {
    if (!isExists(cause)) throw cause;
  }
  return dir;
};

/**
 * Stream `body` into `<changeDirectory>/.attachments/<name>` and answer the absolute path it was
 * stored at. The change directory must exist; only its `.attachments` is created. The body is
 * streamed, never held in memory: a drop may be hundreds of megabytes. A name already taken is
 * numbered rather than overwritten. An upload that fails or is abandoned
 * midway leaves no partial file behind.
 */
export const storeAttachment = (
  changeDirectory: string,
  rawName: string,
  body: ReadableStream<Uint8Array> | null,
): Effect.Effect<string, BadRequestError | InternalError> =>
  Effect.gen(function* () {
    if (body === null) return yield* new BadRequestError({ message: "an attachment needs a body" });
    const name = attachmentName(rawName);
    const dir = yield* Effect.tryPromise({
      try: () => attachmentsIn(changeDirectory),
      catch: (cause) =>
        codeOf(cause) === "ENOENT"
          ? new BadRequestError({ message: "this change's directory is gone" })
          : new InternalError({ message: `could not store ${name}: ${messageOf(cause)}` }),
    });
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const { path, handle } = await createFree(dir, name);
        try {
          await pipeline(Readable.fromWeb(body as never), handle.createWriteStream(), { signal });
        } catch (cause) {
          await handle.close().catch(() => undefined);
          await rm(path, { force: true });
          throw cause;
        }
        return path;
      },
      catch: (cause) => new InternalError({ message: `could not store ${name}: ${messageOf(cause)}` }),
    });
  });
