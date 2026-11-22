/** The persisted harness key has one meaning: the server's `harnessKeyOf` and the Markdown scope
 * key must agree, or a saved selection stops matching the file it names. */
import { expect, test } from "bun:test";

import { harnessKeyOf, type HarnessSource } from "@corvi/contracts/harnesses";
import { keyOf } from "@corvi/markdown/scoped";

test("the harness key builder agrees with the scoped Markdown key", () => {
  const samples: readonly { source: HarnessSource; origin?: string; id: string }[] = [
    { source: "builtin", id: "pi" },
    { source: "global", id: "review" },
    { source: "workspace", origin: "personal", id: "review" },
    { source: "repository", origin: "orders-api", id: "review" },
  ];
  for (const sample of samples) {
    expect(harnessKeyOf(sample.source, sample.origin, sample.id)).toBe(
      keyOf(sample.source, sample.origin, sample.id),
    );
  }
});
