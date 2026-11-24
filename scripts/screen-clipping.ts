/**
 * The clipping rule: whether an element that clips its own content is hiding some of it.
 *
 * The browser side of the capture collects one descriptor per element whose content is larger
 * than its box; this module decides which of those are findings. Keeping the geometry here — and
 * not in the page — makes the rule testable without a browser, and keeps one statement of it for
 * the live walk later.
 *
 * An element clips when its own `overflow` is `hidden` or `clip`; an `auto` or `scroll` container
 * is where the content is meant to be scrolled to, so it is not clipping. Text is what a person
 * loses when it is cut, so a box with no text is not a finding. One truncation is deliberate:
 * `text-overflow: ellipsis` on a horizontal box says the shortened label is the intended form.
 * Vertically there is no such convention — a box that hides its last rows is a bug.
 */
export type ClippingBox = {
  readonly overflowX: string;
  readonly overflowY: string;
  readonly textOverflow: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** The element's own text, trimmed: an icon or a marker carries none, and is not prose. */
  readonly text: string;
};

/** One axis on which content is cut off, with the numbers that say by how much. */
export type Clipping = {
  readonly axis: "horizontal" | "vertical";
  readonly scroll: number;
  readonly client: number;
};

/** What a browser reports as clipping rather than as a scrollbar. */
const CLIPPING: ReadonlySet<string> = new Set(["hidden", "clip"]);

/** How much of a difference is layout rounding rather than content: sub-pixel boxes are not a
 * clipped row. */
const TOLERANCE = 1;

/** The axes on which the box hides content of its own. */
export const clippingOf = (box: ClippingBox): Clipping[] => {
  if (box.text.trim() === "") return [];
  const findings: Clipping[] = [];
  const hidden = (overflow: string, scroll: number, client: number): boolean =>
    CLIPPING.has(overflow) && scroll - client > TOLERANCE;
  if (hidden(box.overflowX, box.scrollWidth, box.clientWidth) && box.textOverflow !== "ellipsis") {
    findings.push({ axis: "horizontal", scroll: box.scrollWidth, client: box.clientWidth });
  }
  if (hidden(box.overflowY, box.scrollHeight, box.clientHeight)) {
    findings.push({ axis: "vertical", scroll: box.scrollHeight, client: box.clientHeight });
  }
  return findings;
};

/** The finding as one line, naming the numbers a person needs to find the box. */
export const describeClipping = (selector: string, clipping: Clipping): string =>
  `${selector} hides its own content: ${clipping.scroll}px of ${clipping.axis} content in ` +
  `${clipping.client}px of room`;
