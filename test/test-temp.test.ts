import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRoots } from "../scripts/clean-test.ts";
import { testTempBase, testTempBaseFor } from "../scripts/test-temp.ts";

/**
 * The test temp base. A run's tree puts the terminal host's unix socket at
 * `<base>/corvi-<token>-<label>-XXXXXX/state/corvi/host.sock`. macOS caps a socket path at 104
 * bytes: a 104-byte path fills `sun_path` and binds (the kernel does not require a NUL when the
 * path is exactly that long), and 105 fails with `EINVAL`, after which the host dies silently.
 * `$TMPDIR` on macOS is a `/var/folders/…` path that walked the wrapper's own root over that
 * budget (its socket was 105); `/tmp` does not.
 */
const SUN_PATH_MAX = 104;

/** The socket a run's tree binds, for a base and a directory `mkdtemp` made (`suffix` stands in
 * for its six random characters). */
const hostSocket = (directory: string): string => join(directory, "state", "corvi", "host.sock");

/** What macOS's `$TMPDIR` looks like: a per-user path under `/var/folders`, long. */
const darwinTemp = "/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T";

test("the base is short on macOS and the given temp elsewhere", () => {
  expect(testTempBaseFor("darwin", darwinTemp)).toBe("/tmp");
  expect(testTempBaseFor("linux", "/var/tmp")).toBe("/var/tmp");
  expect(testTempBaseFor("linux", "/tmp")).toBe("/tmp");
  // The live value, by property rather than by restating the function.
  expect(testTempBase()).toBe(process.platform === "darwin" ? "/tmp" : tmpdir());
});

/** Every label a test passes to `testTempDir(label)`, read from the test files themselves so the
 * worst case is measured rather than claimed. The example above is deliberately not a literal
 * call: the scan would read this comment as a label. */
const shippedLabels = (): string[] => {
  const labels: string[] = [];
  for (const file of readdirSync(import.meta.dir)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    for (const match of source.matchAll(/testTempDir\("([^"]+)"\)/g)) labels.push(match[1]!);
  }
  return labels;
};

test("the longest shipped fixture label leaves the host socket inside sun_path", () => {
  const labels = shippedLabels();
  // The scan is the source of the claim, so it must find the fixture names it measures.
  expect(labels.length).toBeGreaterThan(10);
  expect(labels).toContain("availability-widget-retarget");
  const label = labels.reduce((longest, candidate) =>
    candidate.length > longest.length ? candidate : longest,
  );
  expect(label.length).toBeGreaterThanOrEqual(20);
  // The longest a run token gets: a 10-digit epoch, the dot, a 7-digit pid.
  const token = "1793017479.1234567";
  expect(token).toHaveLength(18);
  const base = testTempBaseFor("darwin", darwinTemp);
  // A fixture dir (`testTempDir(label)`) and the wrapper's own run root; `mkdtemp` appends six
  // random characters to either prefix.
  const fixtureSocket = hostSocket(join(base, `corvi-${token}-${label}-`) + "a1b2c3");
  const runSocket = hostSocket(join(base, `corvi-${token}-root-`) + "a1b2c3");
  for (const socket of [fixtureSocket, runSocket]) {
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(SUN_PATH_MAX);
  }
  // Still a margin, so a longer clock or pid cannot walk it over the limit.
  expect(Buffer.byteLength(fixtureSocket)).toBeLessThanOrEqual(SUN_PATH_MAX - 16);
});

test("the cleaner scans the test temp base and tmpdir(), each as written and resolved", async () => {
  const roots = await testRoots();
  // Deduped: on Linux both bases are the same path, and `realpath` may repeat a spelling.
  expect(new Set(roots).size).toBe(roots.length);
  for (const base of [testTempBase(), tmpdir()]) {
    expect(roots).toContain(base);
    expect(roots).toContain(await realpath(base).catch(() => base));
  }
});
