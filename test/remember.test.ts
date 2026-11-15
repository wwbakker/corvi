import { expect, test } from "bun:test";

import {
  documentKey,
  forgetChange,
  lastViewOf,
  scrollOf,
  seeScroll,
  seeView,
} from "../apps/web/src/app-root/remember.ts";

/**
 * `remember.ts` keeps a change's documents keyed by that change, so `forgetChange` can drop them
 * all with one prefix. A generation in the change part of the key would defeat it — the plan's
 * scroll is keyed by `(source, id)` and the source generation belongs in the document name.
 */
test("a change's remembered plan is forgotten with the change", () => {
  const change = "local\nPROJ-1";
  const plan = documentKey("plan@generation-1", change);
  const other = documentKey("plan@generation-1", "local\nPROJ-2");

  seeScroll(plan, 420);
  seeScroll(other, 10);
  seeView(change, "review");

  expect(plan.startsWith(`${change}\u0000`)).toBe(true);
  expect(lastViewOf(change)).toBe("review");
  expect(scrollOf(plan)).toBe(420);

  forgetChange(change);

  expect(scrollOf(plan)).toBeUndefined();
  expect(lastViewOf(change)).toBe("plan");
  // Another change's document with the same name and generation is untouched.
  expect(scrollOf(other)).toBe(10);
});
