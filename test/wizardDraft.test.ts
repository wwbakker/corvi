import { test, expect } from "bun:test";
import {
  applyPatch,
  EMPTY_DRAFT,
  pickPatch,
  planPatch,
  seedPatch,
  stepContext,
  toChangeDraft,
  type Draft,
  type DraftPatch,
} from "../apps/web/src/wizard/draft.ts";

/**
 * The draft is the wizard's own vocabulary, and `toChangeDraft` is the one place it becomes the
 * creation the API takes. Pinned here rather than only through a browser: the mapping is where
 * an empty heading, a repository's flags and the resolved workspace each get their meaning —
 * and where the plan's heading, the title's one-way source, drives the id and branch.
 */

const draft = (patch: Partial<Draft> = {}): Draft => ({ ...EMPTY_DRAFT, ...patch });

test("a filled draft becomes the creation the route takes", () => {
  const created = toChangeDraft(
    draft({
      id: "PROJ-1",
      branch: "PROJ-1-the-thing",
      plan: "# The thing\n\nthe starting plan",
      repos: [
        { path: "/repos/a", location: "new", branch: { kind: "change" } },
        { path: "/repos/b", location: "original", branch: { kind: "change" }, base: "origin/main" },
      ],
      payloads: { jira: { key: "PROJ-1" } },
    }),
    "workspace-a",
  );

  expect(created).toEqual({
    id: "PROJ-1",
    branch: "PROJ-1-the-thing",
    // The plan's first heading names the change.
    title: "The thing",
    // The wizard always makes an idea: the work starts later, from the change's page.
    state: "Ideation",
    // The plan is the change's PLAN.md, not a field of change.json.
    plan: "# The thing\n\nthe starting plan",
    workspace: "workspace-a",
    checkouts: [
      { path: "/repos/a", location: "new", branch: { kind: "change" } },
      {
        path: "/repos/b",
        location: "original",
        branch: { kind: "change" },
        base: "origin/main",
      },
    ],
    extensions: { jira: { key: "PROJ-1" } },
  });
});

test("an empty draft posts no title and no workspace, and the core fills the gaps", () => {
  const created = toChangeDraft(draft({ id: "PROJ-2" }));

  expect(created.title).toBeUndefined();
  expect(created.workspace).toBeUndefined();
  expect(created.plan).toBe("");
  expect(created.checkouts).toEqual([]);
  expect(created.extensions).toEqual({});
});

test("a plan without a heading leaves the naming to the ticket's summary", () => {
  expect(toChangeDraft(draft({ id: "PROJ-3", plan: "just words\n#\n" })).title).toBeUndefined();
});

test("the id and branch follow the plan's heading until set by hand", () => {
  let held = draft();
  const edit = (plan: string): void => {
    held = applyPatch(held, planPatch(held, plan));
  };

  edit("# The thing\n");
  expect(held).toMatchObject({ id: "the-thing", branch: "the-thing", idTouched: false });
  // Renaming the heading renames them with it.
  edit("# Something else\n");
  expect(held).toMatchObject({ id: "something-else", branch: "something-else" });

  // After an id is set by hand it — and the branch that followed it — are yours.
  held = applyPatch(held, { id: "PROJ-1", idTouched: true });
  edit("# Third name\n");
  expect(held).toMatchObject({ id: "PROJ-1", branch: "third-name" });
});

test("the template seeds a fresh draft's plan once, and never rewrites written-in text", () => {
  const seeded = applyPatch(draft(), seedPatch(draft(), "# Scaffold\n\n## Context\n"));
  expect(seeded).toMatchObject({
    plan: "# Scaffold\n\n## Context\n",
    planSeeded: true,
    headingSeed: "Scaffold",
    id: "scaffold",
  });

  // A draft written in before the template arrived keeps its text; the template only marks
  // itself seeded (and what its heading was, for the pick rule).
  const written = draft({ plan: "# Mine\n" });
  expect(applyPatch(written, seedPatch(written, "# Scaffold\n"))).toMatchObject({
    plan: "# Mine\n",
    planSeeded: true,
    headingSeed: "Scaffold",
  });
});

test("a picked issue names the change only while the heading is still the template's", () => {
  const seeded = applyPatch(draft(), seedPatch(draft(), "# Scaffold\n\n## Context\n"));

  // Untouched: the pick's name becomes the heading, and the id and branch follow it.
  const picked = applyPatch(seeded, pickPatch(seeded, "jira", { label: "PROJ-7", name: "Fix the bug" }));
  expect(picked.plan).toBe("# Fix the bug\n\n## Context\n");
  expect(picked.picks["jira"]).toEqual({ label: "PROJ-7", name: "Fix the bug" });

  // Edited by hand: the pick shows in its field and the plan is left exactly as it is.
  const mine = applyPatch(seeded, planPatch(seeded, "# My own words\n"));
  const untouched = applyPatch(mine, pickPatch(mine, "jira", { label: "PROJ-7", name: "Fix the bug" }));
  expect(untouched.plan).toBe("# My own words\n");
  expect(untouched.picks["jira"]?.label).toBe("PROJ-7");

  // Clearing a pick clears the field and writes nothing.
  const cleared = applyPatch(untouched, pickPatch(untouched, "jira", undefined));
  expect(cleared.picks["jira"]).toBeUndefined();
  expect(cleared.plan).toBe("# My own words\n");
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
  expect(held).toMatchObject({
    id: "PROJ-1",
    branch: "PROJ-1-the-thing",
    idTouched: true,
    branchTouched: true,
  });
  // Setting one of the two leaves the other as it was.
  ctx.setDraft({ id: "PROJ-2" });
  expect(held).toMatchObject({ id: "PROJ-2", branch: "PROJ-1-the-thing" });
});
