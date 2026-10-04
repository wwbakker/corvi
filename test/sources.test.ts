import { expect, test } from "bun:test";

import { changeKey, sourcesFrom } from "../apps/web/src/app-root/sources.ts";

/**
 * The source registry: the local server plus one per remote workspace, and a change identity that
 * keeps two servers' identically-named changes distinct.
 */

test("two sources with the same change id stay distinct", () => {
  expect(changeKey("", "PROJ-1")).not.toBe(changeKey("client", "PROJ-1"));
  expect(changeKey("client", "PROJ-1")).not.toBe(changeKey("other", "PROJ-1"));
  // The same pair is the same key.
  expect(changeKey("client", "PROJ-1")).toBe(changeKey("client", "PROJ-1"));
});

test("sourcesFrom names the local server and each remote workspace", () => {
  const sources = sourcesFrom([
    { id: "local", name: "Local" },
    {
      id: "remote-client",
      name: "Remote client",
      remote: { url: "https://host.ts.net", workspace: "client", token: "t" },
    },
  ]);

  expect(sources[0]).toEqual({ id: "", baseUrl: "" });
  expect(sources[1]).toEqual({
    id: "remote-client",
    baseUrl: "/remote/remote-client",
    remoteWorkspace: "client",
  });
});
