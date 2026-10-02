/**
 * The server-owned screen: a headless xterm per `(sessionId, incarnation)`, fed every host byte
 * and serialized to a page on attach.
 *
 * The page no longer owns the buffer. The host's 256 KiB ring holds only incremental,
 * cursor-addressed bytes, so a continuously updating full-screen window left a reattaching page
 * redrawing its update block on a blank screen — the renderer-owned snapshot cadence has nothing
 * to snapshot while output never goes idle. A second emulator on the server costs ~12 bytes a
 * cell (`Uint32Array(3 * cols)`), ~7–15 MB at the 5,000-row default, and makes a resume exact.
 *
 * `write` takes the host byte offset the chunk starts at, and the screen reports the offset it
 * has applied, so an attach can serialize a consistent screen and resume the live bytes after it.
 * `serialize` appends an absolute-cursor correction and `\e[?25h`: the serialize addon emits DEC
 * modes (bracketed paste among them) but not DECTCEM, so a cursor a full-screen program hid would
 * otherwise stay hidden.
 *
 * Boundary: resume is exact within one server lifetime. After a server restart the screen is
 * rebuilt from the host's 256 KiB ring, so history older than the ring is gone until P2 seeds the
 * screen from the persisted store (`./snapshots.ts`).
 */
import { createRequire } from "node:module";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/headless";

// `@xterm/headless` ships CommonJS, and Node's ESM named-export detection does not see its
// exports, so it is loaded through `require`; the typings come from the package directly.
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as {
  readonly Terminal: new (options: {
    readonly cols: number;
    readonly rows: number;
    readonly scrollback?: number;
    /** The serialize addon reads `buffer.normal`, a proposed API. */
    readonly allowProposedApi?: boolean;
  }) => XTerm;
};

/** The scrollback the page used to keep; the server keeps the same so a resume is indistinguishable. */
export const SCREEN_SCROLLBACK = 5000;

const SHOW_CURSOR = "\x1b[?25h";

export type ScreenSnapshot = {
  /** The serialized screen, replayable into a fresh xterm. */
  readonly data: string;
  /** The host byte offset the screen has applied; live bytes resume from here. */
  readonly offset: number;
};

export type Screen = {
  readonly cols: number;
  readonly rows: number;
  /** Feed host bytes at the offset they start at. Bytes must arrive in order. */
  write(bytes: Uint8Array, seq: number): void;
  /** Resolve once the parser has applied every byte before `seq`. */
  whenApplied(seq: number): Promise<void>;
  /** The parsed screen, its offset, and the corrections a fresh xterm needs to show it. */
  serialize(): ScreenSnapshot;
  resize(cols: number, rows: number): void;
  dispose(): void;
};

/** `\e[{row};{col}H`, the cursor the serialized screen should be left at: the addon's relative
 * moves assume the target has the same geometry, so an explicit position is unambiguous. */
const absoluteCursor = (term: XTerm): string =>
  `\x1b[${term.buffer.active.cursorY + 1};${term.buffer.active.cursorX + 1}H`;

/** One headless emulator at the page's grid. */
export const makeScreen = (size: { readonly cols: number; readonly rows: number }): Screen => {
  const term = new Terminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: SCREEN_SCROLLBACK,
    allowProposedApi: true,
  });
  const addon = new SerializeAddon();
  term.loadAddon(addon);

  /** The host offset of the last byte the parser has applied. */
  let applied = 0;
  let waiters: { readonly atLeast: number; readonly resolve: () => void }[] = [];

  /** Wake the attach waits whose bytes have now parsed. */
  const settle = (): void => {
    if (waiters.length === 0) return;
    const ready = waiters.filter((waiter) => applied >= waiter.atLeast);
    if (ready.length === 0) return;
    waiters = waiters.filter((waiter) => applied < waiter.atLeast);
    for (const waiter of ready) waiter.resolve();
  };

  return {
    get cols(): number {
      return term.cols;
    },
    get rows(): number {
      return term.rows;
    },
    write: (bytes, seq) => {
      // The parser is asynchronous; the callback is where the offset and the attach waits move.
      term.write(bytes, () => {
        applied = seq + bytes.length;
        settle();
      });
    },
    whenApplied: (seq) => {
      if (applied >= seq) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push({ atLeast: seq, resolve });
      });
    },
    serialize: () => {
      const serialized = addon.serialize();
      // An empty screen serializes to "": keep it empty so the route can answer `reset` instead of
      // a snapshot of blank lines.
      return {
        data: serialized === "" ? "" : `${serialized}${absoluteCursor(term)}${SHOW_CURSOR}`,
        offset: applied,
      };
    },
    resize: (cols, rows) => term.resize(cols, rows),
    dispose: () => term.dispose(),
  };
};
