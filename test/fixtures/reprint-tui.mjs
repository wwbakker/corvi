/**
 * A tiny TUI-shaped program for the reprint tests: it draws one base line, then redraws its whole
 * view on every `SIGWINCH`, the way a full-screen agent redraws when its pty size changes. Each
 * jiggle adds a numbered marker, so a test can tell whether the server's first-view jiggle ran and
 * whether a later view ran it again.
 */
process.stdout.write("REPRINT-BASE\r\n");
let repaints = 0;
process.on("SIGWINCH", () => {
  repaints += 1;
  process.stdout.write(`REPRINT-${repaints}\r\n`);
});
// Stay alive: the relay owns the session's lifetime, not this program.
setInterval(() => undefined, 1000);
