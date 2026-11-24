import { expect, test } from "bun:test";
import { compareImages, type RgbaImage } from "../scripts/screen-compare.ts";

/**
 * The comparison's pure half: no browser, no files.
 *
 * What it pins is what the report and the gallery mean by "same" and "changed", and that a
 * capture pair of different sizes is a tool error. A regression here would not fail a capture — it
 * would quietly mislabel the gallery.
 */

/** One opaque colour for every pixel. */
const solid = (width: number, height: number, colour: readonly [number, number, number]): RgbaImage => {
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = colour[0];
    data[at + 1] = colour[1];
    data[at + 2] = colour[2];
    data[at + 3] = 255;
  }
  return { width, height, data };
};

/** The same image with one pixel replaced. */
const withPixel = (
  image: RgbaImage,
  x: number,
  y: number,
  colour: readonly [number, number, number],
): RgbaImage => {
  const data = new Uint8Array(image.data);
  const at = (y * image.width + x) * 4;
  data[at] = colour[0];
  data[at + 1] = colour[1];
  data[at + 2] = colour[2];
  data[at + 3] = 255;
  return { width: image.width, height: image.height, data };
};

/** A bar whose right edge is antialiased: one blended column between the two flat regions. */
const edgeAt = (width: number, height: number, edge: number): RgbaImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < edge ? 0 : x === edge ? 128 : 255;
      const at = (y * width + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
};

test("two identical images are the same", () => {
  const image = solid(8, 8, [10, 20, 30]);
  expect(compareImages(image, solid(8, 8, [10, 20, 30]))).toEqual({ kind: "same" });
});

test("a one-pixel move of an antialiased edge is a change, not renderer noise", () => {
  // `pixelmatch`'s defaults classify both blended columns as antialiasing and report the two
  // pictures of a moved border as identical — the change this tool exists to show.
  const result = compareImages(edgeAt(8, 8, 4), edgeAt(8, 8, 5));
  expect(result.kind).toBe("changed");
  if (result.kind !== "changed") return;
  expect(result.pixels).toBe(16);
});

test("a uniform one-level colour shift over the page is a change", () => {
  const result = compareImages(solid(8, 8, [10, 20, 30]), solid(8, 8, [11, 20, 30]));
  expect(result.kind).toBe("changed");
  if (result.kind !== "changed") return;
  expect(result.pixels).toBe(64);
});

test("a changed pixel is counted, with its share of the image", () => {
  const before = solid(4, 4, [0, 0, 0]);
  const after = withPixel(before, 2, 1, [255, 255, 255]);
  const result = compareImages(before, after);
  expect(result.kind).toBe("changed");
  if (result.kind !== "changed") return;
  expect(result.pixels).toBe(1);
  expect(result.percentage).toBeCloseTo(6.25, 5);
  // The diff marks the changed pixel in red; the rest is the before image, dimmed — not a mark.
  const at = (1 * 4 + 2) * 4;
  expect([...result.diff.subarray(at, at + 3)]).toEqual([255, 0, 0]);
  const untouched = (0 * 4 + 0) * 4;
  expect([...result.diff.subarray(untouched, untouched + 3)]).not.toEqual([255, 0, 0]);
});

test("images of different sizes are a tool error, named by both sizes", () => {
  expect(() => compareImages(solid(4, 4, [0, 0, 0]), solid(5, 4, [0, 0, 0]))).toThrow(
    "the two captures are not the same size: 4x4 and 5x4",
  );
});
