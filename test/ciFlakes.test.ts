import { test, expect } from "bun:test";
import { parseTestLog, summarize, type RunInfo } from "../scripts/ci-flakes.ts";

/**
 * The flake report reads Bun's retry marker, which is the only trace a recovered flake leaves:
 * the run is green, so the conclusion says nothing. These pin the parsing and the grouping, so a
 * change in the log format fails here instead of quietly reporting "no flakes".
 */

const run = (over: Partial<RunInfo> = {}): RunInfo => ({
  id: 1,
  attempt: 1,
  conclusion: "success",
  createdAt: "2026-09-18T12:00:00Z",
  branch: "main",
  title: "a change",
  ...over,
});

const logOf = (...lines: readonly string[]): string => lines.join("\n");

test("a pass on attempt 2 is a retried flake, not a failure", () => {
  const events = parseTestLog(
    logOf(
      "e2e\tUNKNOWN STEP\t2026-09-18T12:00:00.0000000Z ##[group]test/pages.test.ts:",
      "e2e\tUNKNOWN STEP\t2026-09-18T12:00:01.0000000Z (fail) the dashboard fills the window [12.00ms]",
      "e2e\tUNKNOWN STEP\t2026-09-18T12:00:02.0000000Z (pass) the dashboard fills the window (attempt 2) [10.00ms]",
    ),
  );
  expect(events).toEqual([
    { file: "test/pages.test.ts", name: "the dashboard fills the window", outcome: "fail", attempt: 1 },
    {
      file: "test/pages.test.ts",
      name: "the dashboard fills the window",
      outcome: "pass",
      attempt: 2,
    },
  ]);

  const report = summarize([{ run: run(), events }]);
  expect(report.failed).toEqual([]);
  expect(report.retried).toEqual([
    { file: "test/pages.test.ts", name: "the dashboard fills the window", count: 1, runIds: [1] },
  ]);
});

test("a test that failed every attempt is a final failure", () => {
  const events = parseTestLog(
    logOf(
      "##[group]test/terminal.test.ts:",
      "(fail) opening the context menu clears the link tooltip (attempt 3) [952.59ms]",
    ),
  );
  const report = summarize([{ run: run({ id: 7, conclusion: "failure" }), events }]);
  expect(report.red.map((entry) => entry.id)).toEqual([7]);
  expect(report.failed).toEqual([
    {
      file: "test/terminal.test.ts",
      name: "opening the context menu clears the link tooltip",
      count: 1,
      runIds: [7],
    },
  ]);
});

test("the same flake groups across runs, and the summary line is not counted twice", () => {
  const retried = logOf(
    "##[group]test/terminal.test.ts:",
    "(fail) every window's pty is the size the page shows [8.00ms]",
    "(pass) every window's pty is the size the page shows (attempt 2) [4.00ms]",
    "(pass) every window's pty is the size the page shows (attempt 2) [4.00ms]",
  );
  const events = parseTestLog(retried);
  expect(events.filter((event) => event.outcome === "pass")).toHaveLength(1);

  const report = summarize([
    { run: run({ id: 1 }), events },
    { run: run({ id: 2, attempt: 2 }), events },
  ]);
  expect(report.retried).toEqual([
    {
      file: "test/terminal.test.ts",
      name: "every window's pty is the size the page shows",
      count: 2,
      runIds: [1, 2],
    },
  ]);
  expect(report.rerun.map((entry) => entry.id)).toEqual([2]);
});

test("results without a file group still parse, and prose is ignored", () => {
  const events = parseTestLog(
    logOf(
      "the browser shard is skipped: the unit shard failed",
      "(pass) a test whose file header was cut off [1.00ms]",
    ),
  );
  expect(events).toEqual([
    { file: "", name: "a test whose file header was cut off", outcome: "pass", attempt: 1 },
  ]);
});

test("the run's final summary keeps its failures under the file that ran them", () => {
  const events = parseTestLog(
    logOf(
      "##[group]test/pages.test.ts:",
      "(fail) the dashboard fills the window (attempt 3) [9.00ms]",
      "##[endgroup]",
      "##[group]test/other.page.test.ts:",
      "(pass) an unrelated test [1.00ms]",
      "##[endgroup]",
      " 1 tests failed:",
      "(fail) the dashboard fills the window (attempt 3) [9.00ms]",
    ),
  );
  expect(events.filter((event) => event.outcome === "fail")).toEqual([
    { file: "test/pages.test.ts", name: "the dashboard fills the window", outcome: "fail", attempt: 3 },
  ]);
});
