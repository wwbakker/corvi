/**
 * The one switch between a run CI can do and a run a person watches. It is a pure function of the
 * environment so the rule is pinned here rather than by starting a browser: a headed run cannot be
 * asserted in CI, where there is no display, and it must not become a silent skip either.
 *
 * `CORVI_HEADED` is read as `scripts/shot.ts` reads it — any value but the empty string — so the two
 * ways of looking at the app agree on what "headed" means.
 */
import { test, expect } from "bun:test";
import { headlessFor } from "./helpers.ts";

test("a run is headless unless CORVI_HEADED asks for a window", () => {
  expect(headlessFor({})).toBe(true);
  expect(headlessFor({ CORVI_HEADED: "" })).toBe(true);
  expect(headlessFor({ CORVI_HEADED: "1" })).toBe(false);
  expect(headlessFor({ CORVI_HEADED: "0" })).toBe(false);
});
