import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWeb } from "../apps/web/src/node/build.ts";

/**
 * The page's bundle is browser code. The build is half the test — a specifier the bundler cannot
 * resolve fails it — and the output is grepped for Node builtin schemes, so an import that would
 * only fail in the browser cannot sneak in. This is the isolation the removed out-of-tree client
 * chunks used to complicate: with one bundle and no runtime imports, there is one place to check.
 */
test("the page bundle is browser-only", async () => {
  const out = await mkdtemp(join(tmpdir(), "corvi-bundle-"));
  try {
    await buildWeb({ outDir: out });
    const script = await Bun.file(join(out, "app.js")).text();
    expect(script.length).toBeGreaterThan(0);
    expect(script).not.toMatch(/(?:from|require\()\s*["']node:/);

    // The page's other assets are built beside it, not fetched at runtime.
    expect(await Bun.file(join(out, "index.html")).exists()).toBe(true);
    expect(await Bun.file(join(out, "styles.css")).exists()).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
