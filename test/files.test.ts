import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../src/capabilities/files.ts";

/**
 * The write every durable file goes through (change.json, sidecars, settings). A reader must see
 * the old content or the new one, never a mixture, and a writer that fails must not leave its
 * temp file behind.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-files-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("writeAtomic replaces a file with one whole version under concurrency", async () => {
  const path = join(tmp, "concurrent");
  await writeAtomic(path, "start");
  // Eight writers at once, each with content that would be recognisable if two were interleaved.
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => writeAtomic(path, String(i).repeat(5000))),
  );
  const text = await Bun.file(path).text();
  expect(text).toMatch(/^([0-7])\1{4999}$/);
  // No temp files survive a successful write.
  expect((await readdir(tmp)).filter((name) => name.includes(".tmp"))).toEqual([]);
});

test("writeAtomic rejects and leaves no temp behind when the rename cannot finish", async () => {
  const directory = join(tmp, "a-directory");
  await mkdir(directory, { recursive: true });
  // The temp file can be written beside it, but the rename onto a non-empty directory fails.
  await writeAtomic(join(directory, "inside"), "kept");
  await expect(writeAtomic(directory, "x")).rejects.toThrow();
  expect(await Bun.file(join(directory, "inside")).text()).toBe("kept");
  expect((await readdir(tmp)).filter((name) => name.includes(".tmp"))).toEqual([]);
});
