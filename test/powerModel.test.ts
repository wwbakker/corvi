import { expect, test } from "bun:test";

import {
  armable,
  blockersOf,
  formatCountdown,
  isArmable,
  normalizeRemoteUrl,
  powerFromSource,
  powerMachines,
  pruneSelection,
  remainingMs,
  resultText,
  statusLabel,
  type MachineRead,
} from "../apps/web/src/power/model.ts";

test("the machine list is this machine plus each remote, deduped by normalized url", () => {
  const machines = powerMachines([
    { id: "client", name: "Client", remote: { url: "http://a", workspace: "w" } },
    { id: "other", name: "Other", remote: { url: "http://a/", workspace: "x" } },
    { id: "own", name: "Own" },
    { id: "third", name: "Third", remote: { url: "http://b", workspace: "w" } },
  ]);
  expect(machines).toEqual([
    { source: "", label: "This machine", selectedByDefault: true },
    { source: "client", label: "Client", url: "http://a/", selectedByDefault: false },
    { source: "third", label: "Third", url: "http://b/", selectedByDefault: false },
  ]);
  expect(normalizeRemoteUrl("http://a")).toBe("http://a/");
  expect(normalizeRemoteUrl("http://a/b/")).toBe("http://a/b/");
  expect(normalizeRemoteUrl("not a url")).toBe("not a url");
});

test("the countdown formats from the deadline, never below zero", () => {
  const now = 1_000_000;
  expect(formatCountdown(new Date(now + 42_000).toISOString(), now)).toBe("42s");
  expect(formatCountdown(new Date(now + 62_000).toISOString(), now)).toBe("1:02");
  expect(formatCountdown(new Date(now - 5_000).toISOString(), now)).toBe("0s");
  expect(remainingMs(new Date(now + 42_000).toISOString(), now)).toBe(42_000);
  expect(remainingMs(new Date(now - 5_000).toISOString(), now)).toBe(0);
});

test("a status has a headline, and a result adds the server's own words", () => {
  expect(statusLabel("armed")).toBe("Armed");
  expect(statusLabel("disarmed")).toBe("Disarmed");
  expect(statusLabel("unreachable")).toBe("Unreachable");
  expect(statusLabel("unsupported")).toBe("Not supported");
  expect(statusLabel("refused")).toBe("Refused");
  expect(resultText({ source: "a", status: "unreachable" })).toBe("Unreachable");
  expect(resultText({ source: "a", status: "refused", detail: "the remote said no" })).toBe(
    "Refused — the remote said no",
  );
});

test("blockers are the working agents, by label", () => {
  expect(
    blockersOf([
      { label: "pi", working: true },
      { label: "reviewer", working: false },
      { label: "opencode", working: true },
    ]),
  ).toEqual(["pi", "opencode"]);
});

const read = (phase: "armed" | "disarmed" | "counting-down", error: string | null = null): MachineRead => ({
  state: { phase, agents: [] },
  error,
});

test("armable needs a landed, successful read; a failed one is pruned", () => {
  const readings: Record<string, MachineRead> = {
    "": read("disarmed"),
    remote: read("armed", "offline"),
    pending: { state: null, error: null },
  };
  expect(isArmable(readings[""])).toBe(true);
  expect(isArmable(readings.remote)).toBe(false);
  expect(isArmable(readings.pending)).toBe(false);
  expect(isArmable(undefined)).toBe(false);

  expect(armable(new Set([""]), readings)).toBe(true);
  expect(armable(new Set(["", "pending"]), readings)).toBe(false);
  expect(armable(new Set(["", "remote"]), readings)).toBe(false);

  // The failed machine is dropped; the unread one is left for its first read.
  expect(pruneSelection(new Set(["", "remote", "pending"]), readings)).toEqual(new Set(["", "pending"]));
});

test("only a remote power envelope means refetch", () => {
  expect(powerFromSource(JSON.stringify({ source: "a", event: "power", data: "" }))).toBe(true);
  expect(powerFromSource(JSON.stringify({ source: "a", event: "changes", data: "" }))).toBe(false);
  expect(powerFromSource("not json")).toBe(false);
  expect(powerFromSource(JSON.stringify({ event: undefined }))).toBe(false);
});
