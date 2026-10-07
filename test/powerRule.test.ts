import { expect, test } from "bun:test";

import type { SubagentInstanceDto } from "@corvi/contracts/subagents";
import type { PresentedWindow } from "../apps/server/src/terminals/server/index.ts";
import { agentBlockers, agentStates, isQuiet } from "../apps/server/src/power/rule.ts";

/** A presented window with only the fields the rule reads made explicit; the rest are the
 * core's defaults. No `icon` means a plain shell, which is not an agent. */
const window = (over: Partial<PresentedWindow>): PresentedWindow => ({
  index: 0,
  id: "w-1",
  label: "shell",
  detail: "",
  attention: false,
  working: false,
  agent: false,
  active: true,
  activity: false,
  panes: ["w-1"],
  activePane: "w-1",
  busy: false,
  ...over,
});

/** One subagent view, with the defaults an idle, attached instance has. */
const subagent = (over: Partial<SubagentInstanceDto>): SubagentInstanceDto => ({
  id: "s-1",
  changeId: "change",
  profile: "global:reviewer",
  label: "reviewer",
  harness: "pi",
  createdBy: "orchestrator",
  createdAt: "2026-01-01T00:00:00.000Z",
  presence: "attached",
  activity: "idle",
  interrupted: false,
  awaitingReply: false,
  log: [],
  messages: [],
  ...over,
});

test("a working agent window is listed and blocks, and is named", () => {
  const windows = [window({ label: "orders-api - (pi working)", agent: true, working: true })];
  const agents = agentStates(windows, []);
  expect(agents).toEqual([{ label: "orders-api - (pi working)", working: true }]);
  expect(agentBlockers(agents)).toEqual(["orders-api - (pi working)"]);
  expect(isQuiet(agents)).toBe(false);
});

test("a waiting agent is listed as idle and does not block", () => {
  const agents = agentStates(
    [window({ label: "orders-api - (pi waiting)", agent: true, working: false })],
    [],
  );
  expect(agents).toEqual([{ label: "orders-api - (pi waiting)", working: false }]);
  expect(isQuiet(agents)).toBe(true);
});

test("a plain shell is not an agent and does not block", () => {
  const agents = agentStates([window({ label: "orders-api", working: false })], []);
  expect(agents).toEqual([]);
  expect(isQuiet(agents)).toBe(true);
});

test("a working subagent blocks, and is named", () => {
  const subagents = [subagent({ label: "reviewer", activity: "working" })];
  const agents = agentStates([], subagents);
  expect(agents).toEqual([{ label: "reviewer", working: true }]);
  expect(agentBlockers(agents)).toEqual(["reviewer"]);
  expect(isQuiet(agents)).toBe(false);
});

test("an idle subagent is listed as idle and does not block", () => {
  const agents = agentStates([], [subagent({ activity: "idle" })]);
  expect(agents).toEqual([{ label: "reviewer", working: false }]);
  expect(isQuiet(agents)).toBe(true);
});

test("an interrupted (detached) subagent reads idle and does not block", () => {
  const agents = agentStates([], [subagent({ presence: "detached", interrupted: true, activity: "idle" })]);
  expect(isQuiet(agents)).toBe(true);
});

test("a subagent's host window is idle and only its own view blocks", () => {
  // The presenter leaves the host window's `working` false (its own view is the working fact), so
  // the same agent is not named as a blocker twice.
  const windows = [window({ label: "example - (pi working)", agent: false, working: false })];
  const subagents = [subagent({ label: "reviewer", activity: "working" })];
  const agents = agentStates(windows, subagents);
  expect(agentBlockers(agents)).toEqual(["reviewer"]);
  expect(isQuiet(agents)).toBe(false);
});

test("no agents at all is quiet", () => {
  const agents = agentStates([], []);
  expect(agents).toEqual([]);
  expect(agentBlockers(agents)).toEqual([]);
  expect(isQuiet(agents)).toBe(true);
});
