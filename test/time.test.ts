import { expect, test } from "bun:test";
import { ago } from "../apps/server/src/domain/time.ts";

/**
 * How long ago a moment was, in words. Shared by the deployments page (which writes it into a
 * line such as "20260911.3 failed 2h ago") and by the widget rows, so it is tested once, here.
 */

/** That many milliseconds before now, so the test does not have to freeze a clock. */
const before = (ms: number): string => new Date(Date.now() - ms).toISOString();

test("a moment reads as how long ago it was", () => {
  expect(ago(before(0))).toBe("just now");
  expect(ago(before(10_000))).toBe("just now");
  expect(ago(before(5 * 60_000))).toBe("5m ago");
  expect(ago(before(3 * 3_600_000))).toBe("3h ago");
  expect(ago(before(2 * 86_400_000))).toBe("2d ago");
});

test("the unit changes at the hour and the day, and never reads as one long minute", () => {
  // Rounded rather than truncated: the order of magnitude is the point, not the seconds.
  expect(ago(before(90_000))).toBe("2m ago");
  expect(ago(before(59 * 60_000))).toBe("59m ago");
  expect(ago(before(60 * 60_000))).toBe("1h ago");
  expect(ago(before(23 * 3_600_000))).toBe("23h ago");
  expect(ago(before(26 * 3_600_000))).toBe("1d ago");
});

test("nothing at all is said when there is no moment", () => {
  expect(ago(undefined)).toBe("");
  expect(ago(null)).toBe("");
});
