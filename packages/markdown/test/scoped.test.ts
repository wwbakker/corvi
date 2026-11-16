import { expect, test } from "bun:test";

import { keyOf, mergeScopedFiles, type ScopedDiscovery, type ScopedFileInput } from "../src/scoped.ts";

const file = (id: string, source: ScopedFileInput["source"], origin?: string): ScopedFileInput =>
  ({
    id,
    source,
    origin,
    text: "",
  }) as ScopedFileInput;

const merged = (files: ScopedFileInput[]): ScopedDiscovery<string> =>
  mergeScopedFiles(files, (one) => ({ value: `${one.source}:${one.id}` }));

test("keys name the file's place", () => {
  expect(keyOf("repository", "orders-api", "test")).toBe("repository:orders-api:test");
  expect(keyOf("workspace", "personal", "test")).toBe("workspace:personal:test");
  expect(keyOf("global", undefined, "test")).toBe("global:test");
  expect(keyOf("builtin", undefined, "brief")).toBe("builtin:brief");
});

test("the most specific scope wins, except that repositories all stay", () => {
  const one = merged([
    file("brief", "builtin"),
    file("brief", "global"),
    file("review", "global"),
    file("review", "workspace", "personal"),
    file("review", "repository", "api"),
    file("review", "repository", "web"),
  ]);
  expect(one.entries.map((entry) => entry.key)).toEqual([
    "global:brief",
    "repository:api:review",
    "repository:web:review",
  ]);
});

test("a file that does not parse is skipped with its reasons", () => {
  const result = mergeScopedFiles([file("bad", "global")], () => ({ reasons: ["label: required"] }));
  expect(result.entries).toEqual([]);
  expect(result.skipped).toEqual([{ key: "global:bad", reasons: ["label: required"] }]);
});
