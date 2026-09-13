/**
 * The terminal's pure vocabulary, shared by the page and the server: the key that opens a new
 * window, and the sequences a terminal cannot encode by itself.
 *
 * Everything here is deliberately self-contained — no imports, no closure, no runtime — because
 * these are facts about keyboards rather than about either half, and keeping them here is what
 * lets the page and the tests speak the same language.
 */

/** Which desktop the server runs on, as one word. "other" gets the macOS bindings: it is an
 * unsupported platform, and macOS is the UI's fallback. */
export type Platform = "mac" | "linux" | "other";

/** The part of KeyboardEvent the key tests read, so the tests can pass a plain object. */
type Keyish = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
};

export const isNewWindowKey = (e: Keyish, platform: Platform): boolean => {
  // macOS: cmd-t, with ctrl and alt excluded so tmux's ctrl-b chords stay tmux's.
  const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
  // ctrl-alt rather than meta on Linux: Super is the window manager's, and a keydown that
  // reaches the page with it held is a coin toss.
  const linux = e.ctrlKey && e.altKey && !e.metaKey;
  return e.key === "t" && (cmd || (platform === "linux" && linux));
};

/** The CSI u sequences for the Enters a terminal cannot encode: `ESC [ 1 3 ; <modifier> u`.
 * Modifiers are a bitfield above 1: shift 1, alt 2, ctrl 4.
 *
 * xterm.js encodes Enter as a plain carriage return whatever modifier is held — it implements
 * neither the legacy encoding for shift-Enter nor the modern one — so the sequence is sent by
 * the page itself, over tmux's `extended-keys = csi-u`. Plain Enter, alt-Enter and anything
 * with the command key are left to xterm, which encodes those correctly. */
const CSI_U: Record<string, string> = {
  "shift": "\x1b[13;2u",
  "ctrl": "\x1b[13;5u",
  "shift-ctrl": "\x1b[13;6u",
};

export const csiuFor = (e: Keyish): string | undefined => {
  if (e.key !== "Enter" || e.metaKey || e.isComposing) return undefined;
  const held = [e.shiftKey && "shift", e.ctrlKey && "ctrl"].filter(Boolean).join("-");
  return CSI_U[held];
};
