import { test, expect } from "bun:test";
import { branchFor } from "../src/branch.ts";
import { parseIssues, parseSprints } from "../src/integrations/jira.ts";

test("branch name derived from a picked issue", () => {
  expect(branchFor("PROJ-123", "Fix the flaky import")).toBe("PROJ-123-fix-the-flaky-import");
  expect(branchFor("PROJ-1", "Ontwerp: knop & tekst!")).toBe("PROJ-1-ontwerp-knop-tekst");
  expect(branchFor("PROJ-2", "Café naïve")).toBe("PROJ-2-cafe-naive");

  const long = branchFor("PROJ-3", "a".repeat(200));
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long).not.toEndWith("-");
});

test("CSV parsing keeps commas and quotes inside summaries", () => {
  const csv = [
    "TYPE,KEY,SUMMARY,ASSIGNEE,STATUS",
    'Story,PROJ-1,"Compare start, end and ""deactivation"" dates",Ada Lovelace,In Progress',
    "Bug,PROJ-2,Unassigned bug,,To Do",
    "Epic,PROJ-3,An epic we do not work on directly,,To Do",
    "no result found for given query",
  ].join("\n");
  expect(parseIssues(csv, "Sprint 42")).toEqual([
    {
      type: "Story",
      key: "PROJ-1",
      summary: 'Compare start, end and "deactivation" dates',
      assignee: "Ada Lovelace",
      status: "In Progress",
      sprint: "Sprint 42",
    },
    {
      type: "Bug",
      key: "PROJ-2",
      summary: "Unassigned bug",
      assignee: "",
      status: "To Do",
      sprint: "Sprint 42",
    },
  ]);
  // Epics are still readable when a change links to one directly.
  expect(parseIssues(csv, "", false).map((i) => i.key)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
});

test("sprint list is read despite tab padding", () => {
  const stdout = ["ID\tNAME\t\t\t\tSTATE", "19025\t2026-17-Project sprint\tactive", "8970\tProject Refinement\t\tactive"].join("\n");
  expect(parseSprints(stdout)).toEqual([
    { id: "19025", name: "2026-17-Project sprint", state: "active" },
    { id: "8970", name: "Project Refinement", state: "active" },
  ]);
});
