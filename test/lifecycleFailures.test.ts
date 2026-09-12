import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LifecycleFailures } from "../src/app-root/LifecycleFailures.tsx";
import type { ProvisionResult } from "../src/app-root/api.ts";

/**
 * The lifecycle observers' failures as the change page renders them. The component is
 * server-rendered rather than mounted: what it *says* is the interesting part, and the page it
 * sits on needs a browser the rest of the suite does without.
 */

const render = (results?: ProvisionResult[]): string =>
  renderToStaticMarkup(createElement(LifecycleFailures, { results }));

test("a failed lifecycle hook is shown attributed to its extension", () => {
  expect(render([{ integration: "jira", ok: false, error: "ticket is locked" }])).toBe(
    '<div class="error-banner">jira: ticket is locked</div>',
  );
});

test("a successful lifecycle hook changes nothing visible", () => {
  // The operation already succeeded; an observer with nothing to say must not add a banner.
  expect(render([{ integration: "jira", ok: true }])).toBe("");
  expect(render([])).toBe("");
  expect(render(undefined)).toBe("");
});

test("only the failures are shown, in the order they were reported", () => {
  expect(
    render([
      { integration: "git", ok: true },
      { integration: "jira", ok: false, error: "boom" },
      { integration: "ci", ok: false, error: "down" },
    ]),
  ).toBe(
    '<div class="error-banner">jira: boom</div><div class="error-banner">ci: down</div>',
  );
});
