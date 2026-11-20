import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureFonts, fontsDir, SYMBOLS_FONT_FILE } from "../apps/web/src/node/fonts.ts";
import { testTempDir } from "./helpers.ts";

/**
 * The install-time fetch of the Nerd Fonts symbols, against a local mirror rather than GitHub: the
 * suite needs no network. The mirror serves the files `bun install` already fetched, so the pins
 * checked here are the real ones.
 */
type Serve = (name: string, bytes: Uint8Array<ArrayBuffer>) => Response;

let tmp: string;
let serve: Serve = (_name, bytes) => new Response(bytes);
let requests: string[] = [];
let mirror: ReturnType<typeof Bun.serve>;

const source = (): string => `http://127.0.0.1:${mirror.port}`;

beforeAll(async () => {
  tmp = await testTempDir("fonts");
  mirror = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1);
      requests.push(name);
      const bytes = await readFile(join(fontsDir, name)).then(
        (buffer) => new Uint8Array(buffer),
        () => null,
      );
      return bytes === null ? new Response("missing", { status: 404 }) : serve(name, bytes);
    },
  });
});

afterAll(async () => {
  await mirror.stop(true);
  await rm(tmp, { recursive: true, force: true });
});

const fresh = async (label: string): Promise<string> => {
  requests = [];
  serve = (_name, bytes) => new Response(bytes);
  return join(tmp, label);
};

test("the pinned files are fetched, and a second install fetches nothing", async () => {
  const dir = await fresh("installed");
  await ensureFonts(source(), dir);
  expect((await readdir(dir)).sort()).toEqual(["LICENSE", "README.md", SYMBOLS_FONT_FILE]);
  expect(await readFile(join(dir, SYMBOLS_FONT_FILE))).toEqual(
    await readFile(join(fontsDir, SYMBOLS_FONT_FILE)),
  );

  // Offline now: the files on disk match their pins, so nothing is asked for.
  requests = [];
  serve = () => new Response("down", { status: 503 });
  await ensureFonts(source(), dir);
  expect(requests).toEqual([]);
});

test("a file that does not match its pin is refused and never written", async () => {
  const dir = await fresh("tampered");
  serve = (name, bytes) => (name === SYMBOLS_FONT_FILE ? new Response(bytes.slice(1)) : new Response(bytes));
  await expect(ensureFonts(source(), dir)).rejects.toThrow(`${SYMBOLS_FONT_FILE}: sha256`);
  // No font, and no temp file a later run or the build could mistake for one.
  expect(await readdir(dir)).toEqual([]);
});

test("an unreachable mirror is a failure that names the file", async () => {
  const dir = await fresh("unreachable");
  serve = () => new Response("gone", { status: 404 });
  await expect(ensureFonts(source(), dir)).rejects.toThrow(`${SYMBOLS_FONT_FILE}: HTTP 404`);
});

test("a corrupted file on disk is fetched again", async () => {
  const dir = await fresh("corrupted");
  await ensureFonts(source(), dir);
  await Bun.write(join(dir, "LICENSE"), "not the licence");
  requests = [];
  await ensureFonts(source(), dir);
  expect(requests).toEqual(["LICENSE"]);
  expect(await readFile(join(dir, "LICENSE"))).toEqual(await readFile(join(fontsDir, "LICENSE")));
});
