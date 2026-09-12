import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { isTestCommand, isTestSocket, tokenFromPath, tokenOf } from "../scripts/clean-test.ts";

/**
 * `bun run test:clean` decides by command line and socket path alone, because that is all a
 * process shows — and because getting it wrong once killed the app's server and a tmux session
 * with four windows. These are the two shapes it must never confuse.
 */
const roots = ["/var/folders/tp/xyz/T", "/private/var/folders/tp/xyz/T"];

test("a test's ttyd is recognised by the temp change directory it serves", () => {
  const command =
    "ttyd --writable --interface lo0 --port 4321 -t scrollback=0 tmux new-session -A " +
    "-s iwe-PROJ-TERM -c /var/folders/tp/xyz/T/iwe-term-abc123/changes/PROJ-TERM ; " +
    "set-option -t iwe-PROJ-TERM mouse on";
  expect(isTestCommand(command, roots)).toBe(true);
});

test("the same ttyd spelled with the resolved temp path is still a test's", () => {
  const command =
    "ttyd --writable --interface lo0 --port 4321 -t scrollback=0 tmux new-session -A " +
    "-s iwe-PROJ-TERM -c /private/var/folders/tp/xyz/T/iwe-term-abc123/changes/PROJ-TERM";
  expect(isTestCommand(command, roots)).toBe(true);
});

test("the app's ttyd, serving ~/changes, is not", () => {
  const command =
    "ttyd --writable --interface lo0 --port 59026 -t scrollback=0 -t fontSize=13 tmux new-session -A " +
    "-s iwe-PROJ-1681 -c /Users/you/changes/PROJ-1681 ; set-option -t iwe-PROJ-1681 mouse on";
  expect(isTestCommand(command, roots)).toBe(false);
});

test("a path that merely mentions iwe- is not under a test root", () => {
  expect(isTestCommand("ttyd -c /tmp/someone/iwe-thing", roots)).toBe(false);
});

test("a doubled slash is still the same temp directory", () => {
  // macOS's TMPDIR ends in a slash, so a shell-built "$TMPDIR/iwe-x" doubles it.
  expect(
    isTestCommand("ttyd -c /var/folders/tp/xyz/T//iwe-term-abc/changes/PROJ-TERM", roots),
  ).toBe(true);
});

test("a test server names itself; the app's server does not", () => {
  expect(isTestCommand("bun src/server.ts --iwe-test-run", roots)).toBe(true);
  expect(isTestCommand("bun src/server.ts", roots)).toBe(false);
});

test("tmux servers are told apart by their socket", () => {
  expect(isTestSocket("/private/var/folders/tp/xyz/T/iwe-term-abc123/tmux-501/default", roots)).toBe(
    true,
  );
  // Yours: the default socket, however deep /private/tmp may look like a temp dir.
  expect(isTestSocket("/private/tmp/tmux-501/default", roots)).toBe(false);
});

test("a run is named by the token its resources carry", () => {
  expect(tokenOf("bun src/server.ts --iwe-test-run=1a2b.3c4d")).toBe("1a2b.3c4d");
  expect(
    tokenOf("ttyd -c /var/folders/tp/xyz/T/iwe-1a2b.3c4d-term-abc/changes/PROJ"),
  ).toBe("1a2b.3c4d");
  // A resource with no token is one this tool cannot attribute to a run: an old run, or the
  // app's own. It is listed, and only --all ends it.
  expect(tokenOf("bun src/server.ts --iwe-test-run")).toBeUndefined();
  expect(tokenOf("ttyd -c /var/folders/tp/xyz/T/iwe-term-abc123/changes/PROJ")).toBeUndefined();
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
    const spawns = text.match(/\["bun", "src\/server\.ts"/g)?.length ?? 0;
    if (spawns === 0) continue;
    expect(text.match(/--iwe-test-run/g)?.length ?? 0).toBeGreaterThanOrEqual(spawns);
  }
});
