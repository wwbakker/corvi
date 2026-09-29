/**
 * The page half of the real-renderer smoke, bundled for the browser by `page-smoke.ts`. A real
 * `@xterm/xterm` writes a renderer-owned snapshot and the tail bytes, then reports the screen.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";

type RestoreCheck = (
  snapshot: string,
  tailBase64: string,
  cols: number,
  rows: number,
  scrollback: number,
) => Promise<{ cursorX: number; cursorY: number; baseY: number; lines: string[]; serialized: string }>;

declare global {
  interface Window {
    restoreCheck: RestoreCheck;
  }
}

window.restoreCheck = (snapshot, tailBase64, cols, rows, scrollback) =>
  new Promise((resolve) => {
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    const addon = new SerializeAddon();
    term.loadAddon(addon);
    const binary = atob(tailBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    term.write(snapshot);
    term.write(bytes);
    term.write("", () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
      resolve({ cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY, lines, serialized: addon.serialize() });
    });
  });
