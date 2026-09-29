/**
 * The shared xterm adapter for the screen-state spike. Loaded through `createRequire` because
 * `@xterm/headless` and `@xterm/addon-serialize` are CommonJS; the types are local so the spike
 * does not depend on the packages' declarations.
 */
import { createRequire } from "node:module";

export type XtermLine = { translateToString(trimRight?: boolean): string };
export type XtermBuffer = {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(y: number): XtermLine | undefined;
};
export type XtermTerminal = {
  write(data: string | Uint8Array, callback?: () => void): void;
  readonly buffer: { readonly active: XtermBuffer };
  readonly options: { scrollback: number; cols: number; rows: number };
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
};
export type SerializeAddon = { serialize(options?: { scrollback?: number }): string };

const require = createRequire(import.meta.url);
const headless = require("@xterm/headless") as { Terminal: new (options: Record<string, unknown>) => XtermTerminal };
const serializeModule = require("@xterm/addon-serialize") as { SerializeAddon: new () => SerializeAddon };

export const makeTerminal = (cols: number, rows: number, scrollback: number): XtermTerminal =>
  new headless.Terminal({ cols, rows, scrollback, allowProposedApi: true });

export const newSerializeAddon = (): SerializeAddon => new serializeModule.SerializeAddon();

/** Feed raw bytes in small chunks, awaiting each write. Small chunks are the point: an escape or
 * a UTF-8 sequence is split across writes, which the terminal core must reassemble. */
export const feedBytes = (term: XtermTerminal, bytes: Uint8Array, chunkSize = 7): Promise<void> =>
  new Promise((resolve) => {
    if (bytes.length === 0) return resolve();
    let at = 0;
    const step = (): void => {
      if (at >= bytes.length) return resolve();
      const chunk = bytes.subarray(at, Math.min(at + chunkSize, bytes.length));
      at += chunkSize;
      term.write(chunk, step);
    };
    step();
  });

/** Orca's absolute-cursor correction: serialize the screen, then append an explicit cursor
 * position. The addon emits relative moves, which are only right if the target has the same
 * geometry; the absolute move makes the restored cursor unambiguous. */
export const snapshot = (term: XtermTerminal, addon: SerializeAddon): string => {
  const data = addon.serialize();
  const buffer = term.buffer.active;
  return `${data}\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
};

export const restore = (data: string, cols: number, rows: number, scrollback: number): { term: XtermTerminal; addon: SerializeAddon } => {
  const term = makeTerminal(cols, rows, scrollback);
  const addon = newSerializeAddon();
  term.loadAddon(addon);
  return { term, addon };
};

/** The text of every line the buffer holds (scrollback included), right-trimmed. */
export const rowsText = (term: XtermTerminal): string[] => {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  return lines;
};
