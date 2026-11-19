import { expect, test } from "bun:test";
import { join } from "node:path";
import { CORVI_COLOURS, DEFAULT_THEME, THEMES, themeOf, coloursOf } from "../apps/web/src/domain/theme.ts";

/**
 * The theme vocabulary: which looks exist, which one a page starts in, and the named pairs a
 * change wears in Spaces. The stylesheet owns every colour; this pins the vocabulary and the
 * id → pair mapping, and checks that the pairs the mapping names are the ones the sheet writes.
 */

const source = (path: string): Promise<string> => Bun.file(join(import.meta.dir, "..", path)).text();

test("five themes are offered, Dusk first and as the default", () => {
  expect(THEMES.map((theme) => theme.id)).toEqual(["dusk", "ultramarine", "raven", "spaces", "classic"]);
  expect(THEMES[0]!.id).toBe(DEFAULT_THEME);
  expect(THEMES.map((theme) => theme.name)).toEqual([
    "Dusk",
    "Ultramarine",
    "Raven Black",
    "Spaces",
    "Classic",
  ]);
  // Every one names what it is, so the picker needs no second table of prose.
  for (const theme of THEMES) expect(theme.blurb.length).toBeGreaterThan(0);
});

test("a preference that names no known theme reads as Dusk", () => {
  expect(themeOf(null)).toBe("dusk");
  expect(themeOf(undefined)).toBe("dusk");
  expect(themeOf("")).toBe("dusk");
  expect(themeOf("dark")).toBe("dusk");
  for (const theme of THEMES) expect(themeOf(theme.id)).toBe(theme.id);
});

test("ideas and the overview keep Corvi's own pair", () => {
  expect(CORVI_COLOURS).toEqual({ from: "var(--corvi-a)", to: "var(--corvi-b)" });
  // An idea is not a job yet, and no id gives it a colour of its own.
  expect(coloursOf("PROJ-1", true)).toEqual(CORVI_COLOURS);
  expect(coloursOf("idea-agent-briefing", true)).toEqual(CORVI_COLOURS);
  // A change without an id cannot be derived from, so it keeps the pair too.
  expect(coloursOf("", false)).toEqual(CORVI_COLOURS);
});

test("a change's pair is its id's place in a fixed palette", () => {
  // Pinned: a pair is a token name, so the colours can be retuned in the sheet while a change
  // keeps the same place in the palette. The order is the look — reordering it is not a refactor.
  expect(coloursOf("PROJ-1182", false)).toEqual({
    from: "var(--space-2-a)",
    to: "var(--space-2-b)",
  });
  expect(coloursOf("redesign-ui-layout", false)).toEqual({
    from: "var(--space-1-a)",
    to: "var(--space-1-b)",
  });

  // The same id is always the same pair, and it is not the pair of a different id.
  expect(coloursOf("PROJ-1182", false)).toEqual(coloursOf("PROJ-1182", false));
  expect(coloursOf("PROJ-1182", false)).not.toEqual(coloursOf("PROJ-1179", false));

  // Every pair a change can wear is one of the eight, named by both halves.
  for (const id of ["PROJ-1182", "PROJ-1179", "PROJ-1191", "PROJ-1168", "PROJ-1"]) {
    const pair = coloursOf(id, false);
    expect(pair.from).toMatch(/^var\(--space-[1-8]-a\)$/);
    expect(pair.to).toMatch(/^var\(--space-[1-8]-b\)$/);
    expect(pair.from.replace("-a)", "-b)")).toBe(pair.to);
  }
});

test("the pairs a change can wear are written in the stylesheet, not in the theme module", async () => {
  const sheet = await source("apps/web/src/app-root/styles.css");
  expect(sheet).toMatch(/--corvi-a:\s*#[0-9a-f]{6}/);
  expect(sheet).toMatch(/--corvi-b:\s*#[0-9a-f]{6}/);
  for (let index = 1; index <= 8; index++) {
    expect(sheet).toMatch(new RegExp(`--space-${index}-a:\\s*#[0-9a-f]{6}`));
    expect(sheet).toMatch(new RegExp(`--space-${index}-b:\\s*#[0-9a-f]{6}`));
  }
  // The pair has one home: the defaults refer to it instead of restating its colours.
  expect(sheet).toMatch(/--hue-a:\s*var\(--corvi-a\)/);
  expect(sheet).toMatch(/--hue-b:\s*var\(--corvi-b\)/);
  expect(sheet).toMatch(/--change-a:\s*var\(--corvi-a\)/);
  expect(sheet).toMatch(/--change-b:\s*var\(--corvi-b\)/);

  // And the module that names the pairs writes no colour of its own.
  expect(await source("apps/web/src/domain/theme.ts")).not.toMatch(/#[0-9a-f]{6}/i);
});
