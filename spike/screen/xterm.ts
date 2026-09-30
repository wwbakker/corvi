/**
 * The shared xterm adapter for the screen-state spike. Loaded through `createRequire` because
 * `@xterm/headless` and `@xterm/addon-serialize` are CommonJS; the types are local so the spike
 * does not depend on the packages' declarations.
 */
import { createRequire } from "node:module";

export type XtermCell = {
  getChars(): string;
  isBold(): boolean;
  isItalic(): boolean;
  isUnderline(): boolean;
  isBlink(): boolean;
  isInverse(): boolean;
  isDim(): boolean;
  isStrikethrough(): boolean;
  getFgColor(): number;
  getBgColor(): number;
};
export type XtermLine = {
  translateToString(trimRight?: boolean): string;
  readonly length: number;
  getCell(x: number): XtermCell | undefined;
};
export type XtermBuffer = {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly length: number;
  readonly type: "normal" | "alternate";
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
 * geometry; the absolute move makes the restored cursor unambiguous. (The addon also carries the
 * alternate-screen enter itself, so no mode prefix is needed.) */
export const snapshot = (term: XtermTerminal, addon: SerializeAddon): string => {
  const buffer = term.buffer.active;
  const data = addon.serialize();
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

/** Every cell's character and attributes, independently of `addon.serialize`. A serializer that
 * drops SGR cannot make both sides of a comparison agree through this. Heavy — use it on the
 * fidelity terminals, not the 50k-row ones. */
export const cellSignature = (term: XtermTerminal): string => {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (line === undefined) {
      rows.push("");
      continue;
    }
    const cells: string[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell === undefined) {
        cells.push("_");
        continue;
      }
      cells.push(
        `${cell.getChars()}${cell.isBold() ? 1 : 0}${cell.isItalic() ? 1 : 0}${cell.isUnderline() ? 1 : 0}` +
          `${cell.isInverse() ? 1 : 0}${cell.isDim() ? 1 : 0}${cell.isStrikethrough() ? 1 : 0}` +
          `${cell.isBlink() ? 1 : 0}:${cell.getFgColor()}:${cell.getBgColor()}`,
      );
    }
    rows.push(cells.join(""));
  }
  return rows.join("\n");
};

/** A renderer-owned snapshot, keyed to the session incarnation it was taken from. */
export type SnapshotRecord = {
  readonly sessionId: string;
  readonly incarnation: number;
  readonly highWater: number;
  readonly data: string;
};

export const acceptSnapshot = (record: SnapshotRecord, sessionId: string, incarnation: number): boolean =>
  record.sessionId === sessionId && record.incarnation === incarnation;
