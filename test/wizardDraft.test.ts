import { test, expect } from "bun:test";
import {
  applyPatch,
  EMPTY_DRAFT,
  stepContext,
  toChangeDraft,
  type Draft,
  type DraftPatch,
} from "../apps/web/src/wizard/draft.ts";

/**
 * The draft is the wizard's own vocabulary, and `toChangeDraft` is the one place it becomes the
 * creation the API takes. Pinned here rather than only through a browser: the mapping is where
 * an empty field, a repository's flags and the resolved workspace each get their meaning.
 */

const draft = (patch: Partial<Draft> = {}): Draft => ({ ...EMPTY_DRAFT, ...patch });

test("a filled draft becomes the creation the route takes", () => {
  const created = toChangeDraft(
    draft({
      id: "PROJ-1",
      branch: "PROJ-1-the-thing",
      title: "  The thing  ",
      description: "the starting plan",
      repos: [
        { path: "/repos/a", direct: false },
        { path: "/repos/b", direct: true, base: "origin/main" },
      ],
      payloads: { jira: { key: "PROJ-1" } },
    }),
    "workspace-a",
  );

  expect(created).toEqual({
    id: "PROJ-1",
    branch: "PROJ-1-the-thing",
    title: "The thing",
    // The wizard always makes an idea: the work starts later, from the change's page.
    state: "Ideation",
    // The description is the change's PLAN.md, not a field of change.json.
    plan: "the starting plan",
    workspace: "workspace-a",
    repos: ["/repos/a", "/repos/b"],
    direct: ["/repos/b"],
    base: { "/repos/b": "origin/main" },
    extensions: { jira: { key: "PROJ-1" } },
  });
});

test("an empty draft posts no title and no workspace, and the core fills the gaps", () => {
  const created = toChangeDraft(draft({ id: "PROJ-2" }));

  expect(created.title).toBeUndefined();
  expect(created.workspace).toBeUndefined();
  expect(created.plan).toBe("");
  expect(created.repos).toEqual([]);
  expect(created.direct).toEqual([]);
  expect(created.base).toEqual({});
  expect(created.extensions).toEqual({});
});

test("a whitespace title is no title either", () => {
  expect(toChangeDraft(draft({ id: "PROJ-3", title: "   " })).title).toBeUndefined();
});

test("a step's own slot round-trips through its context", () => {
  let held = draft();
  const onPatch = (patch: DraftPatch): void => {
    held = applyPatch(held, patch);
  };
  const ctx = stepContext(held, "workspace-a", onPatch);
  expect(ctx.workspace).toBe("workspace-a");
  expect(ctx.payload("jira")).toBeUndefined();

  // Two picks in one go: the second is resolved against the draft the first wrote, not the copy
  // this render closed over.
  ctx.setPayload("jira", { key: "PROJ-1" });
  ctx.setPayload("github-issues", { repo: "/repos/a", number: 7 });
  expect(held.payloads).toEqual({
    jira: { key: "PROJ-1" },
    "github-issues": { repo: "/repos/a", number: 7 },
  });

  // Read back through the context a reopened wizard builds: the draft is the step's memory.
  expect(stepContext(held, undefined, () => {}).payload("jira")).toEqual({ key: "PROJ-1" });

  // Clearing a pick removes the key rather than storing an undefined: the bag is posted as is.
  ctx.setPayload("jira", undefined);
  expect(held.payloads).toEqual({ "github-issues": { repo: "/repos/a", number: 7 } });
});

test("a step's prefill marks the id and branch as set by hand", () => {
  let held = draft();
  const ctx = stepContext(held, undefined, (patch) => {
    held = applyPatch(held, patch);
  });

  ctx.setDraft({ id: "PROJ-1", branch: "PROJ-1-the-thing" });
  ctx.setTicket("PROJ-1");
  expect(held).toMatchObject({
    id: "PROJ-1",
    branch: "PROJ-1-the-thing",
    idTouched: true,
    branchTouched: true,
    ticket: "PROJ-1",
  });
  // Setting one of the two leaves the other as it was.
  ctx.setDraft({ id: "PROJ-2" });
  expect(held).toMatchObject({ id: "PROJ-2", branch: "PROJ-1-the-thing" });
});
