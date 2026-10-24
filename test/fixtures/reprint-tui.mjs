/**
 * A tiny TUI-shaped program for the reprint tests: it draws one base line, then redraws its whole
 * view on every `SIGWINCH`, the way a full-screen agent redraws when its pty size changes. Each
 * jiggle adds a numbered marker, so a test can tell whether the server's first-view jiggle ran and
 * whether a later view ran it again.
 *
 * `REPRINT_DELAY_MS` delays each redraw, widening the window in which a test can attach, resize or
 * leave during the first view.
 */
const delay = Number(process.env.REPRINT_DELAY_MS ?? "0") || 0;
const paintMs = Number(process.env.REPRINT_PAINT_MS ?? "0") || 0;
process.stdout.write("REPRINT-BASE\r\n");
let repaints = 0;
let paints = 0;
process.on("SIGWINCH", () => {
  repaints += 1;
  const n = repaints;
  setTimeout(() => process.stdout.write(`REPRINT-${n}\r\n`), delay);
});
if (paintMs > 0) {
  setInterval(() => process.stdout.write(`PAINT-${(paints += 1)}\r\n`), paintMs);
}
// Stay alive: the relay owns the session's lifetime, not this program.
setInterval(() => undefined, 1000);
