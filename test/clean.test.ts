import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { isTestCommand, isTestSocket, tokenFromPath, tokenOf } from "../scripts/clean-test.ts";

/**
 * `bun run test:clean` decides by command line and socket path alone, because that is all a
 * process shows — and because getting it wrong once killed the app's server and a tmux session
 * with four windows. These are the shapes it must never confuse.
 */
const roots = ["/var/folders/tp/xyz/T", "/private/var/folders/tp/xyz/T"];

test("a test server names itself; the app's and a dev server do not", () => {
  expect(isTestCommand("node src/server.ts --iwe-test-run")).toBe(true);
  expect(isTestCommand("bun src/server.ts --iwe-test-run=1a2b.3c4d")).toBe(true);
  expect(isTestCommand("node src/server.ts")).toBe(false);
  expect(isTestCommand("bun src/server.ts")).toBe(false);
  expect(isTestCommand("electron src/server.ts")).toBe(false);
  expect(isTestCommand("/opt/iwe/dist/electron src/server.ts")).toBe(false);
});

test("tmux servers are told apart by their socket", () => {
  expect(isTestSocket("/private/var/folders/tp/xyz/T/iwe-term-abc123/tmux-501/default", roots)).toBe(
    true,
  );
  // Yours: the default socket, however deep /private/tmp may look like a temp dir.
  expect(isTestSocket("/private/tmp/tmux-501/default", roots)).toBe(false);
});

test("a run is named by the token its resources carry", () => {
  expect(tokenOf("node src/server.ts --iwe-test-run=1a2b.3c4d")).toBe("1a2b.3c4d");
  expect(tokenFromPath("/private/var/folders/tp/xyz/T/iwe-1a2b.3c4d-term-abc/tmux-501/default")).toBe(
    "1a2b.3c4d",
  );
  // The tmux socket's own directory, short and unlabelled: a unix socket path is capped at 103
  // characters and macOS's `$TMPDIR` is long (test/helpers.ts, `tmuxTempDir`).
  expect(tokenFromPath("/private/var/folders/tp/xyz/T/iwe-1a2b.3c4d-tmux/tmux-501/default")).toBe(
    "1a2b.3c4d",
  );
  // A resource with no token is one this tool cannot attribute to a run: an old run, or the
  // app's own. It is listed, and only --all ends it.
  expect(tokenOf("node src/server.ts --iwe-test-run")).toBeUndefined();
  expect(tokenOf("node src/server.ts")).toBeUndefined();
  expect(tokenFromPath("/var/folders/tp/xyz/T/iwe-term-abc/changes/PROJ")).toBeUndefined();
});

test("a label that looks like a token is not one: the dot is the tell", () => {
  expect(tokenFromPath("/var/folders/tp/xyz/T/iwe-term-abc/changes/PROJ")).toBeUndefined();
  expect(tokenFromPath("/var/folders/tp/xyz/T/iwe-abc.def-term-x/changes/PROJ")).toBe("abc.def");
  expect(tokenFromPath("/private/tmp/tmux-501/default")).toBeUndefined();
});

test("every test that starts a server marks it for the cleaner", async () => {
  // `bun run test:clean` finds a test server by --iwe-test-run. A new test that spawns one
  // without the marker would leave a process the cleaner reports as the app's and refuses to
  // touch — exactly the blind spot this tool exists to remove.
  for (const file of await readdir(import.meta.dir)) {
    if (!file.endsWith(".test.ts")) continue;
    const text = await Bun.file(new URL(file, import.meta.url)).text();
    const spawns = text.match(/\["(?:node|bun)", "src\/server\.ts"/g)?.length ?? 0;
    if (spawns === 0) continue;
    expect(text.match(/--iwe-test-run/g)?.length ?? 0).toBeGreaterThanOrEqual(spawns);
  }
});
