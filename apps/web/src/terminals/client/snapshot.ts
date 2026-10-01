/**
 * The page's screen state, serialized: the renderer-owned half of Phase 3.
 *
 * xterm owns the buffer; on idle, on a hidden tab and on `pagehide` the page serializes it with
 * `@xterm/addon-serialize` and sends it with the host byte offset it covered. The server stores
 * the latest and replays it on connect, then the page attaches from that offset — so a reload
 * keeps the scrollback and no byte is drawn twice.
 *
 * The cap is 1 MiB; a serialization larger than that drops the oldest scrollback rows and keeps
 * the most recent ones (`serialize({ scrollback })` counts from the bottom), because the recent
 * screen is what a restored terminal is for.
 */
export const SCROLLBACK_DEFAULT = 5000;
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
/** How often a changed screen is snapshotted while the socket is hidden (a visible pane
 * snapshots when output settles instead — serializing on a timer stalls typing). */
export const SNAPSHOT_INTERVAL_MS = 5000;
/** How long output must be quiet before a visible pane snapshots it. */
export const SNAPSHOT_IDLE_MS = 1000;

/** The bit of xterm the serializer needs, so the page's `Terminal` and the tests' headless one
 * both fit. */
export type SerializableTerminal = {
  readonly buffer: { readonly active: { readonly cursorX: number; readonly cursorY: number } };
  readonly options: { readonly scrollback?: number };
};
export type Serializer = { serialize(options?: { scrollback?: number }): string };

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Orca's absolute-cursor correction: the addon's relative moves assume the target has the same
 * geometry, so an explicit position makes the restored cursor unambiguous. */
export const absoluteCursor = (term: SerializableTerminal): string =>
  `\x1b[${term.buffer.active.cursorY + 1};${term.buffer.active.cursorX + 1}H`;

/** Serialize the terminal, dropping oldest scrollback rows until it fits `maxBytes`. The estimate
 * is recomputed a bounded number of times (usually twice): the loop this replaces could
 * re-serialize the whole buffer on every row step, and that cost showed up as a stall. */
export const serializeTerminal = (
  term: SerializableTerminal,
  addon: Serializer,
  maxBytes: number = SNAPSHOT_MAX_BYTES,
): string => {
  let rows = term.options.scrollback ?? SCROLLBACK_DEFAULT;
  const draw = (scrollback: number): string => `${addon.serialize({ scrollback })}${absoluteCursor(term)}`;
  let data = draw(rows);
  for (let pass = 0; pass < 4 && byteLength(data) > maxBytes && rows > 0; pass++) {
    // Aim straight at the size, with a small margin so rounding does not land just over again.
    const perRow = byteLength(data) / Math.max(1, rows);
    const target = Math.max(0, Math.floor((maxBytes / perRow) * 0.95));
    rows = target < rows ? target : rows - 1;
    data = draw(rows);
  }
  // Even the viewport alone can exceed the cap. Hand back nothing rather than ship an oversized
  // snapshot; the server would refuse it anyway, and the wire is saved the megabytes.
  return byteLength(data) > maxBytes ? "" : data;
};
