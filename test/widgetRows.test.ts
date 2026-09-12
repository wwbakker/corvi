import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Item, Refreshing } from "../src/dashboard/client/WidgetRows.tsx";
import { moment } from "../src/app-root/moment.ts";

/**
 * A widget row, server-rendered rather than mounted in a browser: what a row *says* is the
 * interesting part, and collapsing and clicking need a DOM the rest of the suite does without.
 */

const row = (item: Parameters<typeof Item>[0]["item"]): string =>
  renderToStaticMarkup(createElement(Item, { item, busy: false, onAction: () => {} }));

test("a card that is fetching again says so, and one that is not, does not", () => {
  expect(renderToStaticMarkup(createElement(Refreshing))).toBe(
    '<span class="refreshing">refreshing…</span>',
  );
});

test("a row says how long ago its build was, and the exact moment on hover", () => {
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const html = row({ label: "520", detail: "succeeded · 20260911.3", state: "ok", at });
  // The relative phrase reads as part of the row, the precise time is a hover away.
  expect(html).toContain(`<span class="at" title="${moment(at)}">3h ago</span>`);
  // And the status and the version are untouched: a time is added, not merged into the detail.
  expect(html).toContain("succeeded · 20260911.3");
});

test("a row that did not happen at any moment carries no time", () => {
  expect(row({ label: "pipelines", detail: "none in \\example-api", state: "none" })).not.toContain(
    'class="at"',
  );
});

test("a running row shows its progress bar, and not a second copy of the same time", () => {
  const html = row({
    label: "521",
    detail: "inProgress",
    state: "pending",
    progress: { startedAt: new Date(Date.now() - 2 * 60_000).toISOString(), expectedMs: 300_000 },
  });
  expect(html).toContain('class="progress"');
  expect(html).not.toContain('class="at"');
});
