/**
 * A stand-in reporter that uses the OSC transport: it emits `ESC ] 1337 ; corvi = <base64 json> BEL`
 * on its own pty, surrounded by TUI-like output, to prove the host parses and strips it.
 *
 *   node osc-reporter.ts working pi [--sequence]
 */
const state = process.argv[2] ?? "working";
const name = process.argv[3];
const emit = (status: string): void => {
  const payload = Buffer.from(JSON.stringify({ status, name }), "utf8").toString("base64");
  process.stdout.write(`\x1b]1337;corvi=${payload}\x07`);
};

// Alternate-screen noise either side, so the test can prove only the OSC is removed.
process.stdout.write("\x1b[?1049h");
emit(state);
process.stdout.write("reporter wrote osc\r\n");
if (process.argv.includes("--sequence")) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  emit("waiting");
}
await new Promise((resolve) => setTimeout(resolve, 3000));
