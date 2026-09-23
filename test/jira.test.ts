import { test, expect } from "bun:test";
import { branchFor } from "../apps/server/src/domain/change.ts";
import { issueFrom } from "@corvi/jira/jira";

test("branch name derived from a picked issue", () => {
  expect(branchFor("PROJ-123", "Fix the flaky import")).toBe("PROJ-123-fix-the-flaky-import");
  expect(branchFor("PROJ-1", "Ontwerp: knop & tekst!")).toBe("PROJ-1-ontwerp-knop-tekst");
  expect(branchFor("PROJ-2", "Café naïve")).toBe("PROJ-2-cafe-naive");

  const long = branchFor("PROJ-3", "a".repeat(200));
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long).not.toEndWith("-");
});

test("an issue is read from the fields we asked Jira for", () => {
  // Commas and quotes need no special handling: the issue comes from structured JSON.
  expect(
    issueFrom(
      {
        key: "PROJ-1",
        fields: {
          summary: 'Compare start, end and "deactivation" dates ',
          status: { name: "In Progress" },
          assignee: { displayName: "Ada Lovelace" },
          issuetype: { name: "Story" },
        },
      },
      "Sprint 42",
    ),
  ).toEqual({
    key: "PROJ-1",
    summary: 'Compare start, end and "deactivation" dates',
    assignee: "Ada Lovelace",
    status: "In Progress",
    type: "Story",
    sprint: "Sprint 42",
  });

  // Unassigned is null rather than absent, and an issue found by key belongs to no sprint here:
  // the sprint is which query found it, not a property of the issue.
  expect(issueFrom({ key: "PROJ-2", fields: { summary: "Bug", assignee: null } })).toEqual({
    key: "PROJ-2",
    summary: "Bug",
    assignee: "",
    status: "",
    type: "",
    sprint: "",
  });
});
