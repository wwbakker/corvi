import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { requireFreshWebBundle, testTempDir } from "./helpers.ts";

/**
 * The stale-bundle tripwire, pinned both ways (test/helpers.ts): the page tests serve the built
 * bundle, so one older than the sources means every page assertion reads yesterday's UI. A
 * check that never refuses is not evidence — the fixture trees here are a built-then-edited
 * web directory, a freshly built one, and one never built at all.
 */

const then = new Date("2020-01-01T00:00:00Z");
const later = new Date("2021-01-01T00:00:00Z");

/** A web directory with one source and one built file, each stamped as said. */
const webDir = async (sourceAt: Date, builtAt: Date | undefined): Promise<string> => {
  const web = await testTempDir("web-bundle");
  mkdirSync(join(web, "src"), { recursive: true });
  writeFileSync(join(web, "src", "page.tsx"), "export {}\n");
  utimesSync(join(web, "src", "page.tsx"), sourceAt, sourceAt);
  if (builtAt !== undefined) {
    mkdirSync(join(web, "dist"), { recursive: true });
    writeFileSync(join(web, "dist", "bundle.js"), "// built\n");
    utimesSync(join(web, "dist", "bundle.js"), builtAt, builtAt);
  }
  return web;
};

test("a bundle older than the sources is refused, and the build that fixes it is named", async () => {
  const web = await webDir(later, then);
  expect(() => requireFreshWebBundle(web)).toThrow("bun run build:web");
});

test("a bundle the last build made is not refused", async () => {
  const web = await webDir(then, later);
  expect(() => requireFreshWebBundle(web)).not.toThrow();
});

test("a web directory never built is refused, not waved through", async () => {
  const web = await webDir(later, undefined);
  expect(() => requireFreshWebBundle(web)).toThrow("bun run build:web");
});
