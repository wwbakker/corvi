/**
 * The comparison's pure part: two images of the same format in, a verdict out.
 *
 * Kept apart from the files and the browser so the gallery's verdicts rest on something testable:
 * `pixelmatch` decides what a differing pixel is, and this module names the answer the report and
 * the gallery print.
 */
import pixelmatch from "pixelmatch";

/**
 * How strictly two captures are compared.
 *
 * Both revisions render on one machine, in one browser, with the system fonts and the same
 * fixture, and two runs of one revision are byte-identical — there is no renderer noise for a
 * tolerant comparator to absorb. `pixelmatch`'s defaults would absorb real changes instead:
 * `includeAA: false` discards a soft 1px boundary move as antialiasing, and `threshold: 0.1`
 * treats a uniform one-level colour shift (about 1/255 of the scale) as equal. Those are exactly
 * the border and rounding changes this tool exists to show, so the comparator is strict: every
 * differing sample counts, whatever its size and whether or not it sits on an antialiased edge.
 * A threshold of 0 means "only an identical sample is equal"; `includeAA` keeps the AA
 * classification from removing the changed edge samples from the count.
 */
const STRICT = { includeAA: true, threshold: 0 } as const;

/** An image as a screenshot writes it: 8-bit RGBA, row-major. */
export type RgbaImage = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

/** What comparing two captures found. */
export type Comparison =
  | { readonly kind: "same" }
  | {
      readonly kind: "changed";
      /** Differing pixels, every sample that differs at all. */
      readonly pixels: number;
      /** Their share of the image, as a percentage. */
      readonly percentage: number;
      /** The diff, in the same RGBA layout, ready to be written as a PNG. */
      readonly diff: Uint8Array;
    };

/** Compare two captures. Both passes use the same viewport, so unequal dimensions are a tool error
 * rather than a verdict: there is no pixel count to give, and a diff would be one image cropped
 * against the other. */
export const compareImages = (before: RgbaImage, after: RgbaImage): Comparison => {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `the two captures are not the same size: ${before.width}x${before.height} and ` +
        `${after.width}x${after.height}`,
    );
  }
  const diff = new Uint8Array(before.width * before.height * 4);
  const pixels = pixelmatch(before.data, after.data, diff, before.width, before.height, STRICT);
  if (pixels === 0) return { kind: "same" };
  return {
    kind: "changed",
    pixels,
    percentage: (pixels / (before.width * before.height)) * 100,
    diff,
  };
};
