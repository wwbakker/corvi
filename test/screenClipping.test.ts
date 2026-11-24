import { expect, test } from "bun:test";
import { clippingOf, describeClipping, type ClippingBox } from "../scripts/screen-clipping.ts";

/**
 * The clipping rule: whether an element that hides its own content is hiding some of it.
 *
 * Geometry only — no browser, no page. `scripts/screen-capture.ts` collects one descriptor per
 * element whose content is larger than its box, and this decides which descriptors are findings.
 */

/** A box that fits its content: overflow is visible, and the content is exactly the box. */
const clippingBox = (overrides: Partial<ClippingBox> = {}): ClippingBox => ({
  overflowX: "visible",
  overflowY: "visible",
  textOverflow: "clip",
  scrollWidth: 100,
  clientWidth: 100,
  scrollHeight: 100,
  clientHeight: 100,
  text: "a label longer than the box it sits in",
  ...overrides,
});

test("a box that hides its own taller content is a clipping finding", () => {
  // The common real bug: a card with `overflow: hidden` and more rows than its height.
  const findings = clippingOf(clippingBox({ overflowY: "hidden", scrollHeight: 240, clientHeight: 80 }));
  expect(findings).toEqual([{ axis: "vertical", scroll: 240, client: 80 }]);
  expect(describeClipping("div.card", findings[0]!)).toBe(
    "div.card hides its own content: 240px of vertical content in 80px of room",
  );
});

test("a box that hides its own wider content is a clipping finding", () => {
  const findings = clippingOf(clippingBox({ overflowX: "hidden", scrollWidth: 260, clientWidth: 100 }));
  expect(findings).toEqual([{ axis: "horizontal", scroll: 260, client: 100 }]);
});

test("a scroll container is where the content goes, not clipping", () => {
  expect(clippingOf(clippingBox({ overflowY: "auto", scrollHeight: 240, clientHeight: 80 }))).toEqual([]);
  expect(clippingOf(clippingBox({ overflowX: "scroll", scrollWidth: 260, clientWidth: 100 }))).toEqual([]);
});

test("a label that truncates with an ellipsis is deliberate", () => {
  expect(
    clippingOf(
      clippingBox({ overflowX: "hidden", textOverflow: "ellipsis", scrollWidth: 260, clientWidth: 100 }),
    ),
  ).toEqual([]);
});

test("a box that hides nothing, or carries no text, is not a finding", () => {
  expect(clippingOf(clippingBox({ overflowY: "visible", scrollHeight: 240 }))).toEqual([]);
  expect(clippingOf(clippingBox({ overflowY: "hidden", scrollHeight: 240, text: "   " }))).toEqual([]);
  // Sub-pixel and one-pixel differences are layout rounding, not a clipped row.
  expect(clippingOf(clippingBox({ overflowY: "hidden", scrollHeight: 101, clientHeight: 100 }))).toEqual([]);
});
