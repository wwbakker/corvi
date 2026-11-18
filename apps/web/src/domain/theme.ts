/**
 * The looks Corvi wears, and the colours a change carries in the Spaces theme.
 *
 * A theme is a set of design tokens in `apps/web/src/app-root/styles.css`: the stylesheet owns
 * every colour, and this module owns only which theme is which and which named pair a change
 * wears. The choice itself is per device and lives in a cookie
 * (`apps/web/src/app-root/theme.ts`).
 */

export type ThemeId = "dusk" | "ultramarine" | "raven" | "spaces";

/** A theme as Settings offers it: the id the stylesheet keys on, and the words beside it. */
export interface ThemeChoice {
  readonly id: ThemeId;
  readonly name: string;
  readonly blurb: string;
}

/** The themes, in the order Settings lists them. */
export const THEMES: readonly ThemeChoice[] = [
  {
    id: "dusk",
    name: "Dusk",
    blurb: "The dusk sky behind frosted panels: ultramarine, violet and orange, with hills below.",
  },
  {
    id: "ultramarine",
    name: "Ultramarine",
    blurb: "A solid ultramarine column, a deep-navy page and translucent blue cards.",
  },
  {
    id: "raven",
    name: "Raven Black",
    blurb:
      "Pure black, and colour as solid blocks: ultramarine for the selection, orange for what wants you.",
  },
  {
    id: "spaces",
    name: "Spaces",
    blurb: "Every change lights the page with its own colour, drawn from its id.",
  },
];

/** Dusk is the default: a stored preference that names no known theme falls back to it. */
export const DEFAULT_THEME: ThemeId = "dusk";

export const themeOf = (value: string | null | undefined): ThemeId =>
  THEMES.find((theme) => theme.id === value)?.id ?? DEFAULT_THEME;

/** A named pair of tokens that belong together: the page's light, and the accent beside it. The
 * values are token references, never colours — `styles.css` is where a colour is written. */
export interface ColourPair {
  readonly from: string;
  readonly to: string;
}

/** Corvi's own pair: ultramarine and orange. The overview and ideas keep it in every theme. */
export const CORVI_COLOURS: ColourPair = {
  from: "var(--corvi-a)",
  to: "var(--corvi-b)",
};

/** The fixed palette a change's pair comes from in Spaces, as tokens. Its order is part of the
 * look: a change's index is derived from its id, so the pairs are never shuffled. */
const SPACE_COLOURS: readonly ColourPair[] = [
  { from: "var(--space-1-a)", to: "var(--space-1-b)" },
  { from: "var(--space-2-a)", to: "var(--space-2-b)" },
  { from: "var(--space-3-a)", to: "var(--space-3-b)" },
  { from: "var(--space-4-a)", to: "var(--space-4-b)" },
  { from: "var(--space-5-a)", to: "var(--space-5-b)" },
  { from: "var(--space-6-a)", to: "var(--space-6-b)" },
  { from: "var(--space-7-a)", to: "var(--space-7-b)" },
  { from: "var(--space-8-a)", to: "var(--space-8-b)" },
];

/** FNV-1a: small, stable, and spread well enough for ids that only differ in their digits. */
const hash = (id: string): number => {
  let value = 2166136261;
  for (let index = 0; index < id.length; index++) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

/** The pair a change wears in Spaces. An idea is not a job yet and keeps Corvi's own colours;
 * a change's pair is its id's place in the palette, so it is the same on every device. */
export const coloursOf = (id: string, idea: boolean): ColourPair =>
  idea || id === "" ? CORVI_COLOURS : SPACE_COLOURS[hash(id) % SPACE_COLOURS.length]!;
