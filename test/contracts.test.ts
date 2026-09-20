import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runSh, testTempDir } from "./helpers.ts";

test("contracts bundle for the browser", async () => {
  const outdir = await testTempDir("contracts-bundle");
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../packages/contracts/src/paths.ts"),
      resolve(import.meta.dir, "../packages/contracts/src/changes.ts"),
      resolve(import.meta.dir, "../packages/contracts/src/api.ts"),
    ],
    target: "browser",
    outdir,
  });
  expect(result.success).toBe(true);
});

test("Node resolves the contracts entrypoints", async () => {
  const result = await runSh([
    "node",
    "--input-type=module",
    "-e",
    "console.log(import.meta.resolve('@corvi/contracts/changes'))",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("packages/contracts/src/changes.ts");
});
