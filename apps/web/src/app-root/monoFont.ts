/**
 * The monospace face this device chose, in front of the page's own stack.
 *
 * Like the theme (`theme.ts`), the choice is per device rather than a config setting — installed
 * fonts differ per machine — and it is kept in the same cookie jar (`prefs.ts`). It applies at once:
 * the root's `--font-mono` changes and every rule that reads it follows. xterm holds a resolved
 * string instead (`monoFontStack`), read when a terminal is created.
 */
import { getPref, setPref } from "./prefs.ts";

/** Where the choice is kept: one key, one device. */
const MONO_FONT_KEY = "corvi:mono-font";

/** The family the stylesheet's `@font-face` declares for the bundled Nerd Fonts icons. */
const SYMBOLS_FONT_FAMILY = "Symbols Nerd Font Mono";

/** An icon only the symbols font draws (a codicon, as pi's footer prints): loading the face for it
 * proves the font arrived, where a letter would be satisfied by any face in the stack. */
const SYMBOLS_PROBE = "\uEC19";

/** A family name as the user typed it, made safe to quote: quotes, backslashes and the characters
 * that end a declaration are not part of any font's name. Empty means no choice. */
const cleanFamily = (typed: string): string => typed.replace(/["'\\;{}\n\r]/g, "").trim();

/** The family this device chose, or "" for the page's default stack. */
export const monoFontInUse = (): string => cleanFamily(getPref(MONO_FONT_KEY) ?? "");

const applyMonoFont = (family: string): void => {
  const root = document.documentElement;
  if (family === "") root.style.removeProperty("--font-mono");
  else root.style.setProperty("--font-mono", `"${family}", var(--font-mono-base)`);
};

/** Choose a family on this device ("" returns to the default): it applies now, and it is what the
 * next visit starts in. A family that is not installed falls through to the rest of the stack. */
export const chooseMonoFont = (typed: string): void => {
  const family = cleanFamily(typed);
  setPref(MONO_FONT_KEY, family);
  applyMonoFont(family);
};

/** Apply the stored choice: the page's first font, before anything has been rendered. */
export const applyStoredMonoFont = (): void => {
  applyMonoFont(monoFontInUse());
};

/** The stack as one CSS font-family string, for a reader that cannot take `var()` (xterm). */
export const monoFontStack = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();

/** Load the bundled icon font, and say whether it loaded. False when the build has none (an install
 * that could not fetch it) — the page then shows the icons as boxes, and Settings says why. Once
 * loaded, a later call answers without fetching again. */
export const loadSymbolsFont = (): Promise<boolean> =>
  document.fonts.load(`16px "${SYMBOLS_FONT_FAMILY}"`, SYMBOLS_PROBE).then(
    (faces) => faces.some((face) => face.status === "loaded"),
    () => false,
  );
