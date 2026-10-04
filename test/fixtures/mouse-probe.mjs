/**
 * A raw-mode mouse probe for the terminal tests: it turns on mouse reporting, then logs every byte
 * it receives on stdin as hex to a file, so a test can assert what the page's xterm sent to the
 * pty.
 *
 * `node mouse-probe.mjs sgr <log> [timeout-ms]` enables `?1002h ?1006h` (SGR encoding, the
 * `onData` path). `default` enables only `?1002h`, so reports use the legacy DEFAULT (X10) encoding
 * and arrive through `onBinary`. Pressing `q`, or the timeout, disables the modes and exits so the
 * shell is left clean for the next test. The timeout is the test's `budget(...)`, not a fixed
 * guess, so a slow machine does not reset the modes mid-test.
 */
import { appendFileSync } from "node:fs";

const [mode = "sgr", log, timeoutArg] = process.argv.slice(2);
if (!log) throw new Error("usage: mouse-probe.mjs <sgr|default> <log-path> [timeout-ms]");
const timeoutMs = Number(timeoutArg) || 120_000;

const quit = "\u001b[?1006l\u001b[?1002l\u001b[?1000l\u001b[?9l";
const stop = () => {
  process.stdout.write(quit);
  appendFileSync(log, "QUIT\n");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(mode === "sgr" ? "\u001b[?1002h\u001b[?1006h" : "\u001b[?1002h");
appendFileSync(log, "READY\n");

process.stdin.on("data", (chunk) => {
  appendFileSync(log, `${chunk.toString("hex")}\n`);
  // Only a bare `q`: an X10 report can itself contain 0x71 (a column or row byte).
  if (chunk.length === 1 && chunk[0] === 0x71) stop();
});

// Never outlive the test: if it is not asked to quit, it still resets the modes and exits.
setTimeout(stop, timeoutMs);
