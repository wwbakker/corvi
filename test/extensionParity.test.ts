import { test, expect } from "bun:test";
import { loaded } from "../src/core/host/index.ts";
import { clients } from "../src/core/host/client.tsx";

/**
 * Parity between the two hand-kept extension registries — the one place the
 * "two lines each" contract of docs/guides/extensions.md is checkable rather than a
 * matter of discipline:
 *
 * - the server's loader, src/core/host/index.ts `loaded`, which knows which
 *   extensions declare wizard steps, pages or change tabs, and
 * - the page's client registry, src/core/host/client.tsx `clients`, which maps an
 *   extension's name to its lazy client module.
 *
 * Both directions are pinned: a wizard step, page or change tab with no client entry shows
 * "loading…" for ever in its host, and a client entry for an extension without any is a chunk
 * nothing ever loads.
 *
 * Out-of-tree extensions (a clientPath on the loaded record) are exempt: their client is a
 * chunk the server built and serves, not an entry in a registry the bundler saw.
 */

/** An extension with an interface on the page: wizard steps, pages or change tabs. */
const interfaceNames = (): string[] =>
  loaded
    .filter(
      (e) =>
        !e.clientPath &&
        (e.wizardSteps.length > 0 || e.pages.length > 0 || e.changeTabs.length > 0),
    )
    .map((e) => e.name);

test("every loaded extension with a wizard step, page or change tab has a client entry", () => {
  for (const name of interfaceNames()) {
    expect(clients[name]).toBeDefined();
  }
});

test("every client entry names a loaded extension with a wizard step, page or change tab", () => {
  const withInterface = new Set(interfaceNames());
  for (const name of Object.keys(clients)) {
    expect(withInterface.has(name)).toBe(true);
  }
});
