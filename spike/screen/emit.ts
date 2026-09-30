/**
 * The content generator, run *inside* a pty by `record.ts`. Its stdout is the recorded stress
 * stream: ordinary scrolling past the host's replay buffer, SGR colours/attributes, wide and
 * emoji cells, cursor moves, an escape written in two pieces, an alternate-screen TUI, and a
 * final tail of scrolling.
 *
 * There is no real `top -b -n1` here on purpose: its output would leak this machine's process
 * list, username and uptime into the committed `stream.bin`. The TUI below is deterministic and
 * covers the same escape surface.
 */
const out = (text: string): void => {
  process.stdout.write(text);
};

// Ordinary scrolling, enough to exceed the host's 256 KB replay buffer.
for (let i = 0; i < 9000; i++) {
  out(`scroll line ${String(i).padStart(5, "0")} lorem ipsum dolor sit amet consectetur\n`);
}

// SGR colours and attributes.
out("\x1b[31mred\x1b[0m \x1b[1;32mbold-green\x1b[0m \x1b[4;34munderline-blue\x1b[0m \x1b[7;33mreverse\x1b[0m\r\n");

// Wide cells and emoji.
out("wide: \u4f60\u597d\u4e16\u754c emoji: \u{1F600} \u{1F680}\r\n");

// Cursor moves away from the end and back.
out("\x1b[3A\x1b[8Cmove\x1b[2B\x1b[3Dback\r\n");

// An escape split across two writes (and, in the runner, across chunk boundaries).
out("\x1b[38;5;196");
out("mpartial-sgr\x1b[0m\r\n");

// A full-screen alternate-screen TUI, top-shaped but deterministic and machine-free.
out("\x1b[?1049h\x1b[H\x1b[2J");
out("\x1b[1;1Htaskwatch - 12:00:00 up 1 day, 1 user, load average: 0.10 0.20 0.30");
out("\x1b[2;1HTasks: 1 running, 2 sleeping, 0 stopped");
out(`\x1b[3;1H${"\u2500".repeat(100)}`);
out("\x1b[5;1HPID   USER    %CPU  %MEM  COMMAND");
for (let i = 0; i < 20; i++) {
  out(`\x1b[${6 + i};1H${String(1000 + i).padEnd(6)}user    ${(i % 10).toFixed(1)}  1.0  node`);
}
out("\x1b[30;20Hpress q to quit");
out("\x1b[?1049l");

// A final tail of scrolling after the TUI.
for (let i = 0; i < 1500; i++) {
  out(`after tui ${String(i).padStart(5, "0")} tail tail tail tail tail\n`);
}
