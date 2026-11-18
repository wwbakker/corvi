/**
 * The theme the page wears, and the colours the open change lights it with.
 *
 * The theme is a browser preference rather than a config setting: it is a per-device choice, kept
 * in the same cookie jar as the column's width (`prefs.ts`), and it applies at once — a theme
 * switch writes the cookie and the attribute the stylesheet keys on, and every rule follows
 * without a reload.
 *
 * Setting `data-theme` is the whole switch: the stylesheet keys every token on it, and the
 * Markdown editor follows through its CSS custom properties (`editor/client/theme.ts`). The one
 * reader that holds a resolved colour is xterm (`TerminalPane.tsx`), which watches the attribute
 * itself. The inline script in `index.html` applies the stored choice before the stylesheet
 * paints; this module applies it again, because the script trusts the cookie where this validates
 * it.
 */
import { type ColourPair, type ThemeId, themeOf } from "../domain/theme.ts";
import { getPref, setPref } from "./prefs.ts";

/** Where the choice is kept: one key, one device. */
const THEME_KEY = "corvi:theme";

/** At most how far the sky moves: half of the mockup's 24px by 16px. */
const SKY_SHIFT = { x: 12, y: 8 } as const;

/** The theme this device last chose, or Dusk when there is none — or when the stored value names
 * a theme this version no longer has. */
export const themeInUse = (): ThemeId => themeOf(getPref(THEME_KEY));

/** The media query that turns the sky still. It is consulted again whenever it changes, so a
 * reader who asks for less motion mid-session gets it without waiting for a theme switch. */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** The theme the page is on, so the media query's changes know whether the sky applies at all. */
let skyTheme: ThemeId | null = null;
let skyHandler: ((event: MouseEvent) => void) | null = null;

/** Stop the sky following the pointer, and put it back where the sheet draws it. */
const stopSky = (): void => {
  if (skyHandler === null) return;
  window.removeEventListener("mousemove", skyHandler);
  skyHandler = null;
  const root = document.documentElement;
  root.style.removeProperty("--sky-x");
  root.style.removeProperty("--sky-y");
};

/** The dusk sky follows the cursor, at a fraction of the mockup's amount. Nothing else moves, and
 * a reader who asked for less motion — now, not only when the theme was chosen — gets a still sky. */
const syncSky = (): void => {
  const wanted = skyTheme === "dusk" && !reducedMotion.matches;
  if (!wanted) {
    stopSky();
    return;
  }
  if (skyHandler !== null) return;
  skyHandler = (event: MouseEvent): void => {
    // The pointer's place in the window, as -1..1 across each axis: the edge is the full shift.
    const across = (event.clientX / window.innerWidth - 0.5) * 2;
    const down = (event.clientY / window.innerHeight - 0.5) * 2;
    document.documentElement.style.setProperty("--sky-x", `${(-across * SKY_SHIFT.x).toFixed(2)}px`);
    document.documentElement.style.setProperty("--sky-y", `${(-down * SKY_SHIFT.y).toFixed(2)}px`);
  };
  window.addEventListener("mousemove", skyHandler, { passive: true });
};

reducedMotion.addEventListener("change", syncSky);

/** The browser's own chrome — the status bar a phone or a docked browser draws — takes the page's
 * base colour, so it does not stay a bar from the theme you left. */
const paintBrowserChrome = (): void => {
  const base = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (base === "") return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta === null) {
    // The page's own script makes this before the first paint; a document that ran no script gets
    // it here, on the first theme application.
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  meta.content = base;
};

/** Put one theme on the page: the attribute the stylesheet keys on, the browser chrome, and the
 * sky the theme owns. */
export const applyTheme = (theme: ThemeId): void => {
  document.documentElement.dataset.theme = theme;
  paintBrowserChrome();
  skyTheme = theme;
  syncSky();
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

/**
 * The colours the open change lights the page with, in Spaces. The values are token references
 * (`domain/theme.ts`) set on the root element, where the theme's sky and the column's swatches
 * read them.
 *
 * `animate` is for a real move from one change to another. The first pair of a page load — a cold
 * deep link included — and a move to or from the overview have nothing to glide from, and are
 * painted: the glide would animate a switch that never happened.
 */
export const applyChangeColours = (colours: ColourPair, animate: boolean): void => {
  const root = document.documentElement;
  root.classList.toggle("hue-instant", !animate);
  root.style.setProperty("--hue-a", colours.from);
  root.style.setProperty("--hue-b", colours.to);
  if (animate) return;
  // Resolve the pair before transitions come back: the next application may glide, but this one
  // is already where it belongs.
  void getComputedStyle(root).getPropertyValue("--hue-a");
  requestAnimationFrame(() => root.classList.remove("hue-instant"));
};
