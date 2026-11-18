/**
 * The theme the page wears, and the colours the open change lights it with.
 *
 * The theme is a browser preference rather than a config setting: it is a per-device choice, kept
 * in the same cookie jar as the column's width (`prefs.ts`), and it applies at once — a theme
 * switch writes the cookie and the attribute the stylesheet keys on, and every rule follows
 * without a reload.
 *
 * xterm resolves a token's value when its theme is set (`TerminalPane.tsx`), so it is the reader
 * that has to be told about a switch; this module's sky shift holds state as well, and both
 * subscribe here. The Markdown editor's theme is CSS custom properties only
 * (`editor/client/theme.ts`), so it follows the attribute like any other rule.
 */
import { type ColourPair, type ThemeId, themeOf } from "../domain/theme.ts";
import { getPref, setPref } from "./prefs.ts";

/** Where the choice is kept: one key, one device. */
const THEME_KEY = "corvi:theme";

/** At most how far the sky moves: half of the mockup's 24px by 16px. */
const SKY_SHIFT = { x: 12, y: 8 } as const;

type ThemeListener = (theme: ThemeId) => void;

const listeners = new Set<ThemeListener>();

/** The theme this device last chose, or Dusk when there is none — or when the stored value names
 * a theme this version no longer has. */
export const themeInUse = (): ThemeId => themeOf(getPref(THEME_KEY));

/** Follow theme switches. Returns the unsubscribe function the reader disposes with. */
export const subscribeTheme = (listener: ThemeListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

let skyHandler: ((event: MouseEvent) => void) | null = null;

/** The dusk sky follows the cursor, at a fraction of the mockup's amount. Nothing else moves, and
 * a reader who asked for less motion gets a still sky. */
const skyFollowsCursor = (on: boolean): void => {
  if (on === (skyHandler !== null)) return;
  if (!on) {
    window.removeEventListener("mousemove", skyHandler!);
    skyHandler = null;
    const root = document.documentElement;
    root.style.removeProperty("--sky-x");
    root.style.removeProperty("--sky-y");
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  skyHandler = (event: MouseEvent): void => {
    // The pointer's place in the window, as -1..1 across each axis: the edge is the full shift.
    const across = (event.clientX / window.innerWidth - 0.5) * 2;
    const down = (event.clientY / window.innerHeight - 0.5) * 2;
    document.documentElement.style.setProperty("--sky-x", `${(-across * SKY_SHIFT.x).toFixed(2)}px`);
    document.documentElement.style.setProperty("--sky-y", `${(-down * SKY_SHIFT.y).toFixed(2)}px`);
  };
  window.addEventListener("mousemove", skyHandler, { passive: true });
};

/** The browser's own chrome — the status bar a phone or a docked browser draws — takes the page's
 * base colour, so it does not stay a bar from the theme you left. */
const paintBrowserChrome = (): void => {
  const base = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (base === "") return;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", base);
};

/** Put one theme on the page: the attribute the stylesheet keys on, the browser chrome, and the
 * readers that hold a resolved colour. */
export const applyTheme = (theme: ThemeId): void => {
  document.documentElement.dataset.theme = theme;
  paintBrowserChrome();
  skyFollowsCursor(theme === "dusk");
  for (const listener of [...listeners]) listener(theme);
};

/** Choose a theme on this device: it applies now, and it is what the next visit starts in. */
export const chooseTheme = (theme: ThemeId): void => {
  setPref(THEME_KEY, theme);
  applyTheme(theme);
};

/** Apply the stored choice: the page's first theme, before anything has been rendered. */
export const applyStoredTheme = (): void => {
  applyTheme(themeInUse());
};

/** The colours the open change lights the page with, in the Spaces theme. The values live on the
 * root element so the sky's gradients, which are tokens, read them. */
export const applyChangeColours = (colours: ColourPair): void => {
  const root = document.documentElement;
  root.style.setProperty("--hue-a", colours.from);
  root.style.setProperty("--hue-b", colours.to);
};
