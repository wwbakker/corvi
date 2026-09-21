import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectoryField } from "../apps/server/src/settings/client/SettingsFields.tsx";
import { DirectoryListing } from "../apps/server/src/workspace/client/DirectoryListing.tsx";
import { listingQuery } from "../apps/server/src/workspace/client/repoListing.ts";
import type { Listing } from "../apps/server/src/app-root/api.ts";

/**
 * The directory control and the listing it reuses. Both are rendered to static markup: the
 * picker's dialog is a browser thing — it opens through an effect — but what the field does with
 * a value, a placeholder or a lock, what the pane shows, and the request both callers make, are
 * decided before any of that.
 */
const listing: Listing = {
  path: "/Users/me/Repos",
  entries: [
    { path: "/Users/me/Repos/acme", name: "acme", isRepo: true },
    { path: "/Users/me/Repos/beta", name: "beta", isRepo: false },
  ],
};

/** The listing with the props every caller must supply, overridden per test. */
const renderListing = (props: Partial<Parameters<typeof DirectoryListing>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(DirectoryListing, {
      listing,
      onOpen: () => {},
      showHidden: false,
      onShowHidden: () => {},
      ...props,
    }),
  );

test("the directory field keeps the input, and adds a way to browse", () => {
  const html = renderToStaticMarkup(
    createElement(DirectoryField, {
      label: "Repositories directory",
      hint: "where it opens",
      value: "~/Repos",
      onChange: () => {},
    }),
  );
  expect(html).toContain("Repositories directory");
  // Typing stays possible: the field is the setting, the picker is an aid to it.
  expect(html).toContain('value="~/Repos"');
  expect(html).toContain("where it opens");
  expect(html).toContain("Browse…");
});

test("a locked directory field cannot be typed in or browsed", () => {
  const html = renderToStaticMarkup(
    createElement(DirectoryField, {
      label: "Repositories directory",
      value: "/tmp/repos",
      locked: "CORVI_REPOSITORIES_DIRECTORY",
      onChange: () => {},
    }),
  );
  expect(html).toContain("set by CORVI_REPOSITORIES_DIRECTORY");
  // Input and button both: the variable wins, so the page does not pretend otherwise.
  expect(html.match(/disabled/g)?.length).toBe(2);
});

test("the hidden box reflects what this listing was asked for", () => {
  expect(renderListing({ showHidden: false })).not.toContain("checked");
  expect(renderListing({ showHidden: true })).toContain("checked");
});

test("the listing says why it is empty, and points at the toggle", () => {
  const withheld = renderListing({ listing: { path: "/tmp", entries: [] } });
  expect(withheld).toContain("empty — hidden directories are not shown");

  const asked = renderListing({ listing: { path: "/tmp", entries: [] }, showHidden: true });
  expect(asked).toContain(">empty<");
});

test("the breadcrumb offers the root and the parent, and nothing at the root", () => {
  const nested = renderListing();
  expect(nested).toContain("Users/me/Repos");
  expect(nested).toContain("↑ Up");

  const root = renderListing({ listing: { path: "/", entries: [] } });
  expect(root).not.toContain("↑ Up");
});

test("the listing's row action and repo tag are up to its caller", () => {
  // No repository action, no repo tag: the picker's footer is the only action there.
  const bare = renderListing();
  expect(bare).not.toContain(">Add<");
  expect(bare).not.toContain(">repo<");

  const withAction = renderListing({
    showRepoTag: true,
    action: () => createElement("button", { type: "button" }, "Add"),
  });
  expect(withAction).toContain(">Add<");
  expect(withAction).toContain(">repo<");
});

test("the listing query is the one request both callers make", () => {
  // Nothing asked for: the server's own start directory, hidden withheld.
  expect(listingQuery({})).toBe("");
  expect(listingQuery({ workspace: "client" })).toBe("workspace=client");
  expect(listingQuery({ hidden: true })).toBe("hidden=1");
  // An explicit path wins over the context, and is encoded like any other query value.
  expect(listingQuery({ path: "/a b" })).toBe("path=%2Fa+b");
  expect(listingQuery({ path: "/a", workspace: "client", hidden: true })).toBe(
    "path=%2Fa&hidden=1",
  );
  // An empty path is not a path: the context (or the global start) answers instead.
  expect(listingQuery({ path: "", workspace: "client" })).toBe("workspace=client");
});
