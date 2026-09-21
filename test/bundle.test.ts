import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The page's bundle is browser code. The build is half the test — a specifier the bundler cannot
 * resolve fails it — and the output is grepped for Node builtin schemes, so an import that would
 * only fail in the browser cannot sneak in. This is the isolation the removed out-of-tree client
 * chunks used to complicate: with one bundle and no runtime imports, there is one place to check.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-bundle-"));
  // The build writes here; the import below reads it, so this must come first.
  process.env.XDG_STATE_HOME = tmp;
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("the page bundle is browser-only", async () => {
  const { ensureClient, clientDir } = await import("../src/app-root/client.ts");
  await ensureClient();

  const script = await Bun.file(join(clientDir, "app.js")).text();
  expect(script.length).toBeGreaterThan(0);
  expect(script).not.toMatch(/(?:from|require\()\s*["']node:/);

  // The page's other assets are built beside it, not fetched at runtime.
  expect(await Bun.file(join(clientDir, "index.html")).exists()).toBe(true);
  expect(await Bun.file(join(clientDir, "styles.css")).exists()).toBe(true);
});
