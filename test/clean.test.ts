import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  coversRun,
  coversUnnamed,
  isRunToken,
  isTestCommand,
  mayRemovePaths,
  tokenFromPath,
  tokenFromPidFile,
  tokenOf,
} from "../scripts/clean-test.ts";

/**
 * `bun run test:clean` decides by command line and path alone, because that is all a process
 * shows — and because getting it wrong once killed the app's server and a user's session with
 * four windows. These are the shapes it must never confuse.
 */

test("a test server names itself; the app's and a dev server do not", () => {
  expect(isTestCommand("node apps/server/src/server.ts --corvi-test-run")).toBe(true);
  expect(isTestCommand("bun apps/server/src/server.ts --corvi-test-run=1a2b.3c4d")).toBe(true);
  expect(isTestCommand("node apps/server/src/server.ts")).toBe(false);
  expect(isTestCommand("bun apps/server/src/server.ts")).toBe(false);
  expect(isTestCommand("electron apps/server/src/server.ts")).toBe(false);
  expect(isTestCommand("/opt/corvi/dist/electron apps/server/src/server.ts")).toBe(false);
});

test("a run is named by the token its resources carry", () => {
  expect(tokenOf("node apps/server/src/server.ts --corvi-test-run=1a2b.3c4d")).toBe("1a2b.3c4d");
  expect(tokenFromPath("/private/var/folders/tp/xyz/T/corvi-1a2b.3c4d-term-abc")).toBe("1a2b.3c4d");
  // A resource with no token is one this tool cannot attribute to a run: an old run, or the
  // app's own. It is listed, and only --all ends it.
  expect(tokenOf("node apps/server/src/server.ts --corvi-test-run")).toBeUndefined();
  expect(tokenOf("node apps/server/src/server.ts")).toBeUndefined();
  expect(tokenFromPath("/var/folders/tp/xyz/T/corvi-term-abc/changes/PROJ")).toBeUndefined();
});

test("a label that looks like a token is not one: the dot is the tell", () => {
  expect(tokenFromPath("/var/folders/tp/xyz/T/corvi-term-abc/changes/PROJ")).toBeUndefined();
  expect(tokenFromPath("/var/folders/tp/xyz/T/corvi-abc.def-term-x/changes/PROJ")).toBe("abc.def");
});

test("a pid-file names its run; the path parser leaves pid-files to it", () => {
  // `tokenFromPath` reads run directories, where the token is followed by `-` or `/`; a pid-file
  // name ends the token in `.pid`, so only `tokenFromPidFile` reads it.
  expect(tokenFromPidFile("corvi-1a2b.3c4d.pid")).toBe("1a2b.3c4d");
  expect(tokenFromPidFile("corvi-abc.def.pid")).toBe("abc.def");
  expect(tokenFromPidFile("corvi-term-abc.pid")).toBeUndefined();
  expect(tokenFromPidFile("corvi-1a2b.3c4d")).toBeUndefined();
  expect(tokenFromPath("corvi-1a2b.3c4d.pid")).toBeUndefined();
  expect(tokenFromPath("/var/folders/tp/xyz/T/corvi-1a2b.3c4d.pid")).toBeUndefined();
  expect(tokenFromPath("/var/folders/tp/xyz/T/corvi-1a2b.3c4d-term-abc")).toBe("1a2b.3c4d");
});

test("a run token is two base36 words in full; a longer word is not a token", () => {
  // What `bun run test` mints (`date +%s.$$`) and what a lone test file mints (test/helpers.ts).
  expect(isRunToken("1789425651.393504")).toBe(true);
  expect(isRunToken("m9k3x1.a1b2c3")).toBe(true);
  // A hand-set token the cleaner cannot read: no dot, uppercase, or an extra word.
  expect(isRunToken("clipA")).toBe(false);
  expect(isRunToken("abc")).toBe(false);
  expect(isRunToken("abc.defG")).toBe(false);
  expect(isRunToken("abc.def.ghi")).toBe(false);
  // The command parser reads a token out of a longer line, but only up to its end: `abc.defG` is
  // not run `abc.def`, so its resources stay unattributed rather than being ended for the wrong
  // run. test/helpers.ts refuses such a token before it can name anything.
  expect(tokenOf("node apps/server/src/server.ts --corvi-test-run=abc.defG")).toBeUndefined();
  expect(tokenOf("node apps/server/src/server.ts --corvi-test-run=abc.def")).toBe("abc.def");
  expect(tokenOf("node apps/server/src/server.ts --corvi-test-run=abc.def --loud")).toBe("abc.def");
});

test("a purge naming its own run takes that run's leftovers and nothing else", () => {
  // Two suites can run at once — several agents on one machine routinely run this suite
  // concurrently. The EXIT trap passes --run=<own>, and its whole contract is "end exactly my
  // run": a neighbour's live fixtures must not look like this run's business, whatever their
  // pid-files briefly say.
  const ownTrap = { all: false, run: "1a2b.3c4d" };
  expect(coversRun(ownTrap, "1a2b.3c4d")).toBe(true); // its own, whatever its pid-file says
  expect(coversRun(ownTrap, "9999.9999")).toBe(false); // a neighbour, gone or not
  expect(coversUnnamed(ownTrap)).toBe(false); // unnamed entries are never its business
  expect(mayRemovePaths(ownTrap)).toBe(true); // --run is explicit, so it may remove
});

test("the default purge removes no paths, even on a quiet machine", () => {
  const byHand = { all: false, run: undefined };
  // A run's liveness is read from one pid-file, and that guess once deleted a live neighbour's
  // fixtures. So the default owns nothing: it leaks rather than guess, quiet or busy.
  expect(coversRun(byHand, "1a2b.3c4d")).toBe(false);
  expect(coversUnnamed(byHand)).toBe(false);
  expect(mayRemovePaths(byHand)).toBe(false);
});

test("--all takes everything, unnamed included", () => {
  const everything = { all: true, run: undefined };
  expect(coversRun(everything, "1a2b.3c4d")).toBe(true);
  expect(coversUnnamed(everything)).toBe(true);
  expect(mayRemovePaths(everything)).toBe(true);
});

test("every test that starts a server marks it for the cleaner", async () => {
  // `bun run test:clean` finds a test server by --corvi-test-run. A new test that spawns one
  // without the marker would leave a process the cleaner reports as the app's and refuses to
  // touch — exactly the blind spot this tool exists to remove.
  for (const file of await readdir(import.meta.dir)) {
    if (!file.endsWith(".test.ts")) continue;
    const text = await Bun.file(new URL(file, import.meta.url)).text();
    const spawns = text.match(/\["(?:node|bun)", "src\/server\.ts"/g)?.length ?? 0;
    if (spawns === 0) continue;
    expect(text.match(/--corvi-test-run/g)?.length ?? 0).toBeGreaterThanOrEqual(spawns);
  }
});
