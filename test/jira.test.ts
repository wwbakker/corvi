import { test, expect } from "bun:test";
import { branchFor } from "../src/core/domain/change.ts";
import { issueFrom } from "../src/extensions/jira/jira.ts";
import { parseJiraConfig } from "../src/extensions/jira/jiraHttp.ts";

test("branch name derived from a picked issue", () => {
  expect(branchFor("PROJ-123", "Fix the flaky import")).toBe("PROJ-123-fix-the-flaky-import");
  expect(branchFor("PROJ-1", "Ontwerp: knop & tekst!")).toBe("PROJ-1-ontwerp-knop-tekst");
  expect(branchFor("PROJ-2", "Café naïve")).toBe("PROJ-2-cafe-naive");

  const long = branchFor("PROJ-3", "a".repeat(200));
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long).not.toEndWith("-");
});

test("an issue is read from the fields we asked Jira for", () => {
  // Commas and quotes need no special handling: the issue comes from structured JSON, not from
  // splitting a CLI's plain output by hand.
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

test("the site, account and board come from jira-cli's own config", () => {
  // Thousands of lines of custom-field schema, four values that matter, all at a known depth.
  const yaml = [
    "auth_type: basic",
    "board:",
    "    id: 169",
    "    name: PROJ board",
    "    type: simple",
    "issue:",
    "    fields:",
    "        custom:",
    "            - name: Sprint",
    "              key: customfield_10104",
    "login: someone@example.com",
    "project:",
    "    key: PROJ",
    "    type: next-gen",
    "server: https://example.atlassian.net/",
  ].join("\n");
  expect(parseJiraConfig(yaml)).toEqual({
    // The trailing slash goes: every path is joined onto this.
    server: "https://example.atlassian.net",
    login: "someone@example.com",
    board: "169",
    project: "PROJ",
  });

  // A file that is not there, or not jira-cli's, says so by having nothing in it.
  expect(parseJiraConfig("")).toEqual({
    server: undefined,
    login: undefined,
    board: undefined,
    project: undefined,
  });
});
