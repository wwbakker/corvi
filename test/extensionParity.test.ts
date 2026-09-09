import { test, expect } from "bun:test";
import { loaded } from "../src/extensions/index.ts";
import { clients } from "../src/web/extensions.tsx";

/**
 * Parity between the two hand-kept extension registries — the one place the
 * "two lines each" contract of docs/extensions.md is checkable rather than a
 * matter of discipline:
 *
 * - the server's loader, src/extensions/index.ts `loaded`, which knows which
 *   extensions declare wizard steps, and
 * - the page's client registry, src/web/extensions.tsx `clients`, which maps an
 *   extension's name to its lazy client module.
 *
 * Both directions are pinned: a wizard step with no client entry shows "… has no
 * interface on this page" in the wizard, and a client entry for an extension
 * without steps is a chunk nothing ever loads.
 */

const wizardNames = () =>
  loaded.filter((e) => e.wizardSteps.length > 0).map((e) => e.name);

test("every loaded extension with wizard steps has a client entry", () => {
  for (const name of wizardNames()) {
    expect(clients[name]).toBeDefined();
  }
});

test("every client entry names a loaded extension with wizard steps", () => {
  const withSteps = new Set(wizardNames());
  for (const name of Object.keys(clients)) {
    expect(withSteps.has(name)).toBe(true);
  }
});
