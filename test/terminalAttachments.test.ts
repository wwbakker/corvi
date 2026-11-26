import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Exit } from "effect";
import {
  ATTACHMENTS_DIR,
  attachmentName,
  numberedName,
  storeAttachment,
} from "../apps/server/src/terminals/server/attachments.ts";
import {
  clipboardFileName,
  clipboardPayload,
  formatBytes,
  largeUpload,
  pastedPaths,
  shellQuote,
  type TerminalUpload,
} from "../apps/web/src/terminals/client/payload.ts";
import { testTempDir } from "./helpers.ts";

const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

describe("terminal attachments on the server", () => {
  test("a name is one usable path segment", () => {
    expect(attachmentName("shot.png")).toBe("shot.png");
    expect(attachmentName("../../etc/passwd")).toBe("passwd");
    expect(attachmentName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(attachmentName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(attachmentName("..")).toBe("attachment");
    expect(attachmentName("dir/")).toBe("attachment");
    expect(attachmentName("")).toBe("attachment");
    const long = attachmentName(`${"x".repeat(400)}.png`);
    expect(long.length).toBe(160);
    expect(long.endsWith(".png")).toBe(true);
  });

  test("a taken name is numbered before its extension", () => {
    expect(numberedName("shot.png", 0)).toBe("shot.png");
    expect(numberedName("shot.png", 2)).toBe("shot-2.png");
    expect(numberedName("Makefile", 1)).toBe("Makefile-1");
    expect(numberedName(".env", 1)).toBe(".env-1");
  });

  test("stores the body under the change's attachments, never overwriting", async () => {
    const change = await testTempDir("attach");
    const first = await Effect.runPromise(storeAttachment(change, "shot.png", streamOf("one", "-two")));
    const second = await Effect.runPromise(storeAttachment(change, "shot.png", streamOf("three")));
    expect(first).toBe(join(change, ATTACHMENTS_DIR, "shot.png"));
    expect(second).toBe(join(change, ATTACHMENTS_DIR, "shot-1.png"));
    expect(await readFile(first, "utf8")).toBe("one-two");
    expect(await readFile(second, "utf8")).toBe("three");
  });

  test("a body that fails midway leaves no file behind", async () => {
    const change = await testTempDir("attach-fail");
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("the client went away"));
      },
    });
    const exit = await Effect.runPromiseExit(storeAttachment(change, "half.bin", failing));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readdir(join(change, ATTACHMENTS_DIR))).toEqual([]);
  });

  test("a change directory that is gone is not recreated", async () => {
    const gone = join(await testTempDir("attach-gone"), "moved-to-the-archive");
    const failure = await Effect.runPromise(Effect.flip(storeAttachment(gone, "late.txt", streamOf("x"))));
    expect(failure._tag).toBe("BadRequestError");
    expect(await readdir(dirname(gone))).toEqual([]);
  });

  test("a request without a body is the caller's mistake", async () => {
    const change = await testTempDir("attach-empty");
    const failure = await Effect.runPromise(Effect.flip(storeAttachment(change, "x", null)));
    expect(failure._tag).toBe("BadRequestError");
  });
});

describe("terminal drop and paste payloads", () => {
  test("a path is quoted only when the shell would split or expand it", () => {
    expect(shellQuote("/home/me/change/.attachments/shot.png")).toBe("/home/me/change/.attachments/shot.png");
    expect(shellQuote("/tmp/my shot.png")).toBe("'/tmp/my shot.png'");
    expect(shellQuote("/tmp/it's.png")).toBe(`'/tmp/it'\\''s.png'`);
    expect(shellQuote("/tmp/$HOME*.png")).toBe("'/tmp/$HOME*.png'");
  });

  test("several paths paste as words with a trailing space", () => {
    expect(pastedPaths(["/a/b.png", "/a/c d.png"])).toBe("/a/b.png '/a/c d.png' ");
    expect(pastedPaths([])).toBe("");
  });

  test("a large upload asks first, naming its size", () => {
    // Only the size is read: a stand-in saves allocating hundreds of megabytes.
    const upload = (name: string, size: number): TerminalUpload => ({ name, blob: { size } as Blob });
    const mb = 1024 * 1024;
    expect(largeUpload([upload("small.bin", 200 * mb)])).toBeUndefined();
    expect(largeUpload([upload("big.bin", 250 * mb)])).toEqual({ what: "big.bin", size: "250 MB" });
    expect(largeUpload([upload("a", 150 * mb), upload("b", 150 * mb)])).toEqual({
      what: "2 files",
      size: "300 MB",
    });
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  test("a clipboard image is named by when it was pasted and its type", () => {
    const at = new Date(2026, 10, 25, 18, 30, 42);
    expect(clipboardFileName("image/png", at)).toBe("paste-20261125-183042.png");
    expect(clipboardFileName("image/jpeg", at)).toBe("paste-20261125-183042.jpg");
    expect(clipboardFileName("image/svg+xml", at)).toBe("paste-20261125-183042.svg");
    expect(clipboardFileName("weird", at)).toBe("paste-20261125-183042.bin");
  });

  const item = (parts: Record<string, Blob>): ClipboardItem =>
    ({
      types: Object.keys(parts),
      getType: async (type: string) => parts[type]!,
    }) as unknown as ClipboardItem;
  const clipboardWith = (items: readonly ClipboardItem[] | Error, text = ""): Clipboard =>
    ({
      read: async () => {
        if (items instanceof Error) throw items;
        return items;
      },
      readText: async () => text,
    }) as unknown as Clipboard;
  const now = (): Date => new Date(2026, 0, 2, 3, 4, 5);

  test("the clipboard's text wins over an image beside it", async () => {
    const both = clipboardWith([
      item({ "image/png": new Blob(["png"]) }),
      item({ "text/plain": new Blob(["hello"]) }),
    ]);
    expect(await clipboardPayload(both, now)).toEqual({ kind: "text", text: "hello" });
  });

  test("an image is taken in an image type, and a clipboard without one is not uploaded", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const offered = item({ "application/x-custom": new Blob(["?"]), "image/png": png });
    expect(await clipboardPayload(clipboardWith([offered]), now)).toEqual({
      kind: "files",
      files: [{ name: "paste-20260102-030405.png", blob: png }],
    });
    const copiedFile = item({ "x-special/gnome-copied-files": new Blob(["copy\nfile:///a"]) });
    expect(await clipboardPayload(clipboardWith([copiedFile]), now)).toEqual({ kind: "empty" });
  });

  test("an image alone on the clipboard becomes an upload", async () => {
    const image = new Blob(["png"], { type: "image/png" });
    const payload = await clipboardPayload(clipboardWith([item({ "image/png": image })]), now);
    expect(payload).toEqual({ kind: "files", files: [{ name: "paste-20260102-030405.png", blob: image }] });
  });

  test("a clipboard that refuses the rich read falls back to its text", async () => {
    expect(await clipboardPayload(clipboardWith(new Error("denied"), "plain"), now)).toEqual({
      kind: "text",
      text: "plain",
    });
    const textOnly = { readText: async () => "" } as unknown as Clipboard;
    expect(await clipboardPayload(textOnly, now)).toEqual({ kind: "empty" });
  });
});
