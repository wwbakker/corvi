import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange, readChangeEffect } from "../src/changes.ts";
import { Effect } from "effect";
import {
  extensionsFor,
  loaded,
  wizardStepsFor,
} from "../src/extensions/index.ts";
import { repoFromRemote } from "../src/extensions/github-issues/index.ts";
import { refOf, refLabel } from "../src/extensions/github-issues/shared.ts";
import { ticketOf } from "../src/extensions/jira/shared.ts";
import { config, type Workspace } from "../src/config.ts";
import type { Change } from "../src/types.ts";

/**
 * A changes root of its own, because creating a change writes one.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-extensions-"));
  process.env.IWE_ROOT = tmp;
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: "test", name: "Test", ...patch });

test("a remote URL is read in every shape GitHub answers to", () => {
  const parse = (url: string) => repoFromRemote(url);
  expect(parse("https://github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(parse("https://github.com/owner/name")).toEqual({ owner: "owner", name: "name" });
  expect(parse("git@github.com:owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(parse("ssh://git@github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(parse("git://github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  // A trailing newline is what some shells hand back.
  expect(parse("https://github.com/owner/name.git\n")).toEqual({ owner: "owner", name: "name" });
  // Not GitHub, not ours to guess at.
  expect(parse("https://gitlab.com/owner/name.git")).toBeUndefined();
  expect(parse("/some/local/path")).toBeUndefined();
});

test("a change's ticket is read from the bag, and from the legacy field", () => {
  const bag: Change = { id: "A", branch: "A", repos: [], extensions: { jira: { key: "PROJ-2" } }, createdAt: "" };
  const legacy: Change = { id: "B", branch: "B", repos: [], jira: "PROJ-1", createdAt: "" };
  const neither: Change = { id: "C", branch: "C", repos: [], createdAt: "" };

  // The bag is where the wizard writes now; change.jira is where it was written before
  // extensions existed, and archived changes still carry it.
  expect(ticketOf(bag)).toBe("PROJ-2");
  expect(ticketOf(legacy)).toBe("PROJ-1");
  expect(ticketOf(neither)).toBeUndefined();
});

test("an extension's issue is named by repository and number, and read from the bag", () => {
  const change: Change = {
    id: "A",
    branch: "A",
    repos: [],
    createdAt: "",
    extensions: { "github-issues": { repo: "/repos/thing", number: 7 } },
  };
  const ref = refOf(change);
  expect(ref).toEqual({ repo: "/repos/thing", number: 7 });
  expect(refLabel("owner/thing", ref!)).toBe("owner/thing#7");
  expect(refOf({ id: "B", branch: "B", repos: [], createdAt: "" })).toBeUndefined();
});

test("a workspace that names no extensions has them all", () => {
  const enabled = extensionsFor(ws()).map((e) => e.name);
  // The built-ins, whatever they are — and the jira extension among them.
  expect(enabled).toEqual(loaded.map((e) => e.name));
  expect(enabled).toContain("jira");
});

test("a workspace that names its extensions gets exactly those, in registration order", () => {
  const enabled = extensionsFor(ws({ extensions: ["ci", "github-issues"] })).map((e) => e.name);
  expect(enabled).toEqual(["ci", "github-issues"]);
  // An empty list means none: an extension cannot sneak back in.
  expect(extensionsFor(ws({ extensions: [] }))).toEqual([]);
  // A name nothing loaded answers for is simply not there.
  expect(extensionsFor(ws({ extensions: ["github-issues", "nonexistent"] })).map((e) => e.name)).toEqual([
    "github-issues",
  ]);
});

test("the legacy jira flag still means something while a workspace names no extensions", () => {
  // A context without Jira has no ticket to pick: its extension is not there at all.
  const without = extensionsFor(ws({ jira: false })).map((e) => e.name);
  expect(without).toContain("ci");
  expect(without).not.toContain("jira");
  // But an explicit list outranks the old flag: naming jira enables it even here.
  expect(extensionsFor(ws({ jira: false, extensions: ["jira"] })).map((e) => e.name)).toEqual(["jira"]);
});

test("the wizard's steps follow the phases and the enablement", () => {
  const withJira = wizardStepsFor(ws({ extensions: ["jira", "github-issues"] }));
  // Issue steps first (they prefill the change), repository-aware steps after the repositories.
  expect(withJira.map((s) => [s.extension, s.phase])).toEqual([
    ["jira", "issue"],
    ["github-issues", "repos"],
  ]);
  // A context that dropped jira has no step to show for it, not an empty one.
  const withoutJira = wizardStepsFor(ws({ extensions: ["github-issues"] }));
  expect(withoutJira.map((s) => s.extension)).toEqual(["github-issues"]);
});

test("a completion step is planned only when the change has something for it", () => {
  // The jira extension's contributor: planned for a change with a ticket, absent without one,
  // readable from either place the key may live.
  const jira = loaded.find((e) => e.name === "jira")!;
  const contributor = jira.completionSteps[0]!;
  const ctx = { config, workspace: ws() };
  expect(contributor.plan({ id: "A", branch: "A", repos: [], createdAt: "", jira: "PROJ-1" }, ctx)).toEqual({
    id: "jira",
    label: "move PROJ-1 to Done",
    state: "waiting",
  });
  const withBag: Change = { id: "B", branch: "B", repos: [], createdAt: "", extensions: { jira: { key: "PROJ-2" } } };
  expect(contributor.plan(withBag, ctx)?.label).toBe("move PROJ-2 to Done");
  expect(contributor.plan({ id: "C", branch: "C", repos: [], createdAt: "" }, ctx)).toBeUndefined();

  // The github-issues extension's: the label names the issue without a subprocess, so the plan
  // is honest about what is coming before anything runs.
  const gh = loaded.find((e) => e.name === "github-issues")!;
  const ghPlanned = gh.completionSteps[0]!.plan(
    { id: "D", branch: "D", repos: [], createdAt: "", extensions: { "github-issues": { repo: "/r/thing", number: 9 } } },
    ctx,
  );
  expect(ghPlanned?.label).toBe("close thing#9");
  expect(gh.completionSteps[0]!.plan({ id: "E", branch: "E", repos: [], createdAt: "" }, ctx)).toBeUndefined();
});

test("the wizard's payload lands on the change record, verbatim and per extension", async () => {
  const created = await createChange({
    id: "PROJ-BAG",
    repos: ["/tmp/whatever-repo"],
    workspace: "test",
    extensions: {
      jira: { key: "PROJ-5" },
      "github-issues": { repo: "/repos/thing", number: 12 },
    },
  });
  const read = await Effect.runPromise(readChangeEffect("PROJ-BAG"));
  // The core stores what the extensions picked and never looks inside: both survive as written.
  expect(read?.extensions).toEqual({
    jira: { key: "PROJ-5" },
    "github-issues": { repo: "/repos/thing", number: 12 },
  });
  expect(ticketOf(created)).toBe("PROJ-5");
});
