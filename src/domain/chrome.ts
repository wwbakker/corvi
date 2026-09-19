/**
 * The window's own chrome: the band of the page that is the title bar, and the traffic lights
 * that sit in it (docs/manual/interface.md).
 *
 * One copy of the numbers, because two processes lay the same band out: the main process places
 * the traffic lights in the window (scripts/app/electron/main.ts) and the page draws the row
 * under them (src/app-root/app.tsx, which hands the height to the CSS as `--titlebar-height`).
 * A mismatch is a strip whose contents sit beside the buttons instead of below them.
 *
 * The page also runs in a plain browser, where there are no lights and nothing to drag: there,
 * the height is still the height of the page's first row, so the layout is the same one.
 */

/** How tall the page's first row is: a page header everywhere, the window's title bar in the app.
 * Tall enough for a control beside the change's name, and for the traffic lights macOS keeps. */
export const TITLE_BAR_HEIGHT = 38;

/**
 * macOS' traffic lights in the app's window: 12px circles 20px apart, and how much of the row they
 * take. `position` is given explicitly rather than left to `hiddenInset`, because a position we
 * choose is what makes `inset` a constant the page can lay out against.
 */
export const TRAFFIC_LIGHTS = {
  /** The first button's top-left, and the pitch macOS draws between them. */
  position: { x: 14, y: (TITLE_BAR_HEIGHT - 12) / 2 },
  /** What the row has to keep clear: the three buttons from `x` (66px), plus breathing room. */
  inset: 78,
} as const;
