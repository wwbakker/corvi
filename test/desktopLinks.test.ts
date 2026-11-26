import { expect, test } from "bun:test";
import { isOursUrl, opensExternally } from "../apps/desktop/src/electron/links.ts";

test("the app window keeps its own page and hands only web links to the system", () => {
  expect(isOursUrl("http://127.0.0.1:4000/changes/X")).toBe(true);
  expect(isOursUrl("https://github.com/x/y")).toBe(false);
  expect(opensExternally("https://github.com/x/y")).toBe(true);
  expect(opensExternally("mailto:me@example.com")).toBe(true);
  // A file dropped on the window navigates to its `file:` URL: never opened by another program.
  expect(opensExternally("file:///home/me/run-me.sh")).toBe(false);
  expect(opensExternally("javascript:alert(1)")).toBe(false);
  expect(opensExternally("not a url")).toBe(false);
});
