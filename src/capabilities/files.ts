/**
 * Files, without a runtime of their own.
 *
 * The server used to read and write through Bun's `Bun.file`/`Bun.write`; it runs on Node now
 * (docs/decisions/node-server.md), so this is the same shape over `node:fs/promises`: `file()`
 * answers existence, text and JSON, and `write()` writes. Call sites changed their import, not
 * their line.
 *
 * Failure is the caller's: a missing file rejects, exactly as `Bun.file(...).text()` did, and
 * every caller already treats that as "no file" where that is what it means.
 */
import { readFile, rename, stat, writeFile } from "node:fs/promises";

export type FileHandle = {
  exists: () => Promise<boolean>;
  text: () => Promise<string>;
  json: <T>() => Promise<T>;
};

export const file = (path: string): FileHandle => ({
  exists: async (): Promise<boolean> =>
    await stat(path).then(
      () => true,
      () => false,
    ),
  text: (): Promise<string> => readFile(path, "utf8"),
  json: async <T>(): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T,
});

export const write = async (path: string, data: string | Uint8Array): Promise<void> => {
  await writeFile(path, data);
};

/** Write a file so a reader never sees it half-written: a temp file beside it, then a rename.
 * The page is read on every request, and more than one server can own the same state directory
 * — a test run beside the running app — so a plain write races its own readers. */
export const writeAtomic = async (path: string, data: string | Uint8Array): Promise<void> => {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
};

/** A file as an HTTP response, or null where there is none: the routes that serve a generated
 * or committed asset all want the same "404 unless it is there" behaviour. */
export const fileResponse = async (
  path: string,
  headers: Record<string, string> = {},
): Promise<Response | null> => {
  try {
    return new Response(await readFile(path), { headers });
  } catch {
    return null;
  }
};
