import { expect, test } from "bun:test";

import type { RepositoryViewDto } from "@corvi/contracts/api";
import { DirectoryName, RepositoryId } from "@corvi/contracts/changes";
import { checkoutRows, describeCheckout } from "../apps/server/src/change-page/client/repositoryView.ts";

const view = (
  checkout: RepositoryViewDto["checkout"],
  state: RepositoryViewDto["state"] = "Active",
): RepositoryViewDto => ({
  repositoryId: RepositoryId.make("demo:repo"),
  directoryName: DirectoryName.make("repo"),
  state,
  checkoutLocation: "/changes/demo/repo",
  checkout,
});

test("a missing checkout reads as its own fact", () => {
  expect(describeCheckout(view({ _tag: "Missing" }))).toBe("no checkout");
});

test("a present checkout shows the branch and a short head", () => {
  expect(describeCheckout(view({ _tag: "Present", branch: "demo", head: "abcdef1234567890" }))).toBe(
    "demo @ abcdef1",
  );
});

test("a detached checkout shows the head and says so", () => {
  expect(describeCheckout(view({ _tag: "Present", head: "abcdef1234567890" }))).toBe("abcdef1 (detached)");
  expect(describeCheckout(view({ _tag: "Present" }))).toBe("present");
});

test("rows carry the name, state, location, and detail", () => {
  const rows = checkoutRows([view({ _tag: "Present", branch: "demo" }, "Archived")]);
  expect(rows).toEqual([
    {
      name: DirectoryName.make("repo"),
      state: "Archived",
      detail: "demo",
      location: "/changes/demo/repo",
    },
  ]);
});
