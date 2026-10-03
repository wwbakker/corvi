/**
 * The server-owned screen: a headless xterm per `(sessionId, incarnation)`, fed every host byte
 * and serialized to a page on attach.
 *
 * The page no longer owns the buffer. The host's 256 KiB ring holds only incremental,
 * cursor-addressed bytes, so a continuously updating full-screen window left a reattaching page
 * redrawing its update block on a blank screen — a renderer-side snapshot cadence has nothing
 * to snapshot while output never goes idle. A second emulator on the server costs ~12 bytes a
 * cell (`Uint32Array(3 * cols)`), ~7–15 MB at the 5,000-row default, and makes a resume exact.
 *
 * `write` takes the host byte offset the chunk starts at, and the screen reports the offset it
 * has applied, so an attach can serialize a consistent screen and resume the live bytes after it.
 * `serialize` appends an absolute-cursor correction and `\e[?25h`: the serialize addon emits DEC
 * modes (bracketed paste among them) but not DECTCEM, so a cursor a full-screen program hid would
 * otherwise stay hidden. A screen larger than the cap serializes to its most recent rows with a
 * `truncated` flag, never to the empty string: the empty result means a genuinely empty screen.
 *
 * Boundary: the screen content is exact while the store holds it. After a server restart the hub
 * seeds the stored screen and attaches the host from its offset; if the host's ring has already
 * evicted past that offset there is a gap (see `./session.ts` for the policy). The serialize addon
 * restores the text and the modes it knows, not every parser state, and the offset can fall
 * mid-escape, so "exact" is screen-content exact rather than byte-exact.
 */
import { createRequire } from "node:module";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/headless";
import { SNAPSHOT_MAX_BYTES } from "./snapshots.ts";

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
  /** The serialized screen, replayable into a fresh xterm. Only a genuinely empty screen is "". */
  readonly data: string;
  /** The host byte offset the screen has applied; live bytes resume from here. */
  readonly offset: number;
  /** The screen exceeded the cap and `data` is the most recent rows that fit, not the whole
   * scrollback. `data` is never "" when this is true, so a truncated screen is never mistaken for
   * an empty one (a blank page, or a store entry to drop). */
  readonly truncated: boolean;
};

export type Screen = {
  readonly cols: number;
  readonly rows: number;
  /** Feed host bytes at the offset they start at. Bytes must arrive in order. */
  write(bytes: Uint8Array, seq: number): void;
  /** Load a stored serialized screen and set the host offset it covers. The bytes are the store's
   * replay, not host bytes; the offset is the host offset they represent, so a host attach can
   * resume from it. */
  seed(data: string, offset: number): void;
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

  /** The host offset of the last byte the parser has applied. Monotonic: a ring byte that lands
   * behind an earlier (seeded) offset must not pull it back, or the regressed high-water would be
   * persisted and the next resume would replay bytes already covered. */
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
      // Monotonic: the gap policy can land ring bytes behind a seeded offset, and those must not
      // pull the applied offset back (the screen still draws them, the offset just stays ahead).
      term.write(bytes, () => {
        applied = Math.max(applied, seq + bytes.length);
        settle();
      });
    },
    seed: (data, offset) => {
      // The seed is a screen replay, not host bytes: apply it, then claim the host offset it
      // covers so a later attach resumes exactly from there. Monotonic for the same reason as
      // `write`: a seed applied after a ring chunk must not pull the offset back either.
      term.write(data, () => {
        applied = Math.max(applied, offset);
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
      const bytes = (text: string): number => new TextEncoder().encode(text).length;
      const draw = (scrollback: number): string => {
        const serialized = addon.serialize({ scrollback });
        return serialized === "" ? "" : `${serialized}${absoluteCursor(term)}${SHOW_CURSOR}`;
      };
      const full = draw(SCREEN_SCROLLBACK);
      // A screen larger than the cap is trimmed to its most recent rows, with a bounded number of
      // estimate passes rather than one re-serialize per row. `data` is never "" for a screen that
      // has content: the trimmed draw can come back empty when all content is in the dropped
      // scrollback, so the full draw is the floor. That keeps the empty sentinel meaning
      // "genuinely empty" only — a blank page or a store entry to drop must not be a truncation.
      let rows = SCREEN_SCROLLBACK;
      let data = full;
      let truncated = false;
      if (bytes(data) > SNAPSHOT_MAX_BYTES) {
        truncated = true;
        for (let pass = 0; pass < 4 && bytes(data) > SNAPSHOT_MAX_BYTES && rows > 0; pass++) {
          const perRow = bytes(data) / Math.max(1, rows);
          rows = Math.max(0, Math.min(rows - 1, Math.floor((SNAPSHOT_MAX_BYTES / perRow) * 0.95)));
          data = draw(rows);
        }
        if (data === "") data = full;
      }
      return { data, offset: applied, truncated };
    },
    resize: (cols, rows) => term.resize(cols, rows),
    dispose: () => term.dispose(),
  };
};
