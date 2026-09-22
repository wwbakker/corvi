import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LifecycleFailures } from "../apps/web/src/app-root/LifecycleFailures.tsx";
import type { ProvisionResult } from "../apps/web/src/app-root/api.ts";

/**
 * The provisioning failures as the change page renders them. The component is server-rendered
 * rather than mounted: what it *says* is the interesting part, and the page it sits on needs a
 * browser the rest of the suite does without.
 */

const render = (results?: ProvisionResult[]): string =>
  renderToStaticMarkup(createElement(LifecycleFailures, { results }));

test("a failed provisioning step is shown attributed to its integration", () => {
  expect(render([{ integration: "jira", ok: false, error: "ticket is locked" }])).toBe(
    '<div class="error-banner">jira: ticket is locked</div>',
  );
});

test("a successful provisioning step changes nothing visible", () => {
  // The operation already succeeded; a step with nothing to say must not add a banner.
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
