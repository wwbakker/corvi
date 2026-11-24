import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunVersionProblem,
  classify,
  discoverGroups,
  discoverTestFiles,
  fileFiltersOf,
  filesForMode,
  importsBrowserAtRuntime,
  isMode,
  isTerminalGroup,
  repeatOf,
  runPlan,
  withoutRepeat,
} from "../scripts/test-run.ts";

/**
 * The runner's classification is the only place that decides which files a mode runs, so these
 * pin the partition instead of restating the rule: terminal and rest split the browser e2e files,
 * and browser e2e plus unit split everything discovered.
 */

test("terminal and rest partition the browser e2e files", () => {
  const groups = discoverGroups();
  expect(groups.e2eTerminal.length).toBeGreaterThan(0);
  expect(groups.e2eRest.length).toBeGreaterThan(0);
  // Every e2e file is on exactly one side, decided by the same name rule the runner uses.
  for (const file of groups.e2e) {
    expect(isTerminalGroup(file)).toBe(groups.e2eTerminal.includes(file));
  }
  // `e2e` is the two groups together: nothing dropped, nothing duplicated.
  expect([...groups.e2e].sort()).toEqual([...groups.e2eTerminal, ...groups.e2eRest].sort());
  expect(new Set(groups.e2e).size).toBe(groups.e2e.length);
  expect(groups.e2eTerminal.filter((file) => groups.e2eRest.includes(file))).toEqual([]);
});

test("browser e2e and unit partition every discovered test file", () => {
  const groups = discoverGroups();
  const discovered = discoverTestFiles();
  expect([...groups.unit, ...groups.e2e].sort()).toEqual([...discovered].sort());
  expect(new Set(discovered).size).toBe(discovered.length);
  expect(groups.unit.filter((file) => groups.e2e.includes(file))).toEqual([]);
});

test("each mode maps to its files", () => {
  const groups = discoverGroups();
  expect(filesForMode("unit", groups)).toEqual(groups.unit);
  expect(filesForMode("e2e-terminal", groups)).toEqual(groups.e2eTerminal);
  expect(filesForMode("e2e-rest", groups)).toEqual(groups.e2eRest);
  expect(filesForMode("e2e", groups)).toEqual([...groups.e2eTerminal, ...groups.e2eRest]);
  expect(filesForMode("all", groups)).toEqual([...groups.unit, ...groups.e2eTerminal, ...groups.e2eRest]);
});

test("the modes are the documented set; a typo is not a mode", () => {
  for (const mode of ["all", "unit", "e2e", "e2e-terminal", "e2e-rest"]) {
    expect(isMode(mode)).toBe(true);
  }
  expect(isMode("e2e-all")).toBe(false);
  expect(isMode("")).toBe(false);
  expect(isMode(undefined)).toBe(false);
});

test("classification is the line-oriented Playwright import or a shared launch helper", () => {
  expect(importsBrowserAtRuntime('import { chromium } from "playwright";')).toBe(true);
  expect(importsBrowserAtRuntime('  import { chromium, firefox } from "playwright";')).toBe(true);
  expect(importsBrowserAtRuntime('import {\n  chromium,\n} from "playwright";')).toBe(false);
  expect(importsBrowserAtRuntime('import type { Browser } from "playwright";')).toBe(false);
  expect(importsBrowserAtRuntime('import { chromium } from "playwright-core";')).toBe(false);
  // The page tests launch through the shared helper, so that import is the browser signal now.
  expect(importsBrowserAtRuntime('import {\n  openBrowser,\n} from "./helpers.ts";')).toBe(true);
  // A file that launches the browser itself names the helper and no engine at all.
  expect(importsBrowserAtRuntime('import {\n  launchBrowser,\n  testTempDir,\n} from "./helpers.ts";')).toBe(
    true,
  );
  expect(importsBrowserAtRuntime('import { browserAvailable } from "./helpers.ts";')).toBe(true);
  // A unit file imports from the same helpers without launching anything.
  expect(importsBrowserAtRuntime('import { runEffect } from "./helpers.ts";')).toBe(false);
  expect(isTerminalGroup("test/terminal.test.ts")).toBe(true);
  expect(isTerminalGroup("test/terminalAcceptance.test.ts")).toBe(true);
  expect(isTerminalGroup("test/pages.test.ts")).toBe(false);
  expect(classify("test/pages.test.ts", 'import { chromium } from "playwright";')).toBe("e2e-rest");
  expect(classify("test/pages.test.ts", 'import {\n  openBrowser,\n} from "./helpers.ts";')).toBe("e2e-rest");
  expect(classify("test/terminal.test.ts", 'import { chromium } from "playwright";')).toBe("e2e-terminal");
  expect(classify("test/terminal.test.ts", 'import { launchBrowser } from "./helpers.ts";')).toBe(
    "e2e-terminal",
  );
  expect(classify("test/terminal.test.ts", "// no browser import")).toBe("unit");
});

test("a temp fixture: a single-line import is e2e, multi-line and type-only are unit", () => {
  const root = mkdtempSync(join(tmpdir(), "test-run-fixture-"));
  try {
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test/single.test.ts"), 'import { chromium } from "playwright";\n');
    writeFileSync(join(root, "test/multi.test.ts"), 'import {\n  chromium,\n} from "playwright";\n');
    writeFileSync(join(root, "test/type-only.test.ts"), 'import type { Page } from "playwright";\n');
    writeFileSync(join(root, "test/terminalThing.test.ts"), 'import { chromium } from "playwright";\n');
    writeFileSync(join(root, "test/other.test.ts"), "// not a browser file\n");
    writeFileSync(join(root, "test/engine.test.ts"), 'import {\n  openBrowser,\n} from "./helpers.ts";\n');
    writeFileSync(join(root, "test/launch.test.ts"), 'import {\n  launchBrowser,\n} from "./helpers.ts";\n');
    writeFileSync(join(root, "test/unit.test.ts"), 'import { runEffect } from "./helpers.ts";\n');

    const groups = discoverGroups(root);
    expect(groups.e2eTerminal).toEqual(["test/terminalThing.test.ts"]);
    expect(groups.e2eRest).toEqual(["test/engine.test.ts", "test/launch.test.ts", "test/single.test.ts"]);
    expect(groups.unit).toEqual([
      "test/multi.test.ts",
      "test/other.test.ts",
      "test/type-only.test.ts",
      "test/unit.test.ts",
    ]);
    expect(groups.e2e).toEqual([
      "test/terminalThing.test.ts",
      "test/engine.test.ts",
      "test/launch.test.ts",
      "test/single.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a positional argument is a file filter; a flag's value is not", () => {
  expect(fileFiltersOf(["subagentsCard"])).toEqual(["subagentsCard"]);
  expect(fileFiltersOf(["test/subagentsCard.page.test.ts"])).toEqual(["test/subagentsCard.page.test.ts"]);
  expect(fileFiltersOf(["--retry=2", "subagentsCard"])).toEqual(["subagentsCard"]);
  // `-t` and its name are one argument pair: the name must not read as a file.
  expect(fileFiltersOf(["-t", "a change's page id", "gateway"])).toEqual(["gateway"]);
  expect(fileFiltersOf(["--test-name-pattern", "the card"])).toEqual([]);
  expect(fileFiltersOf(["--timeout", "30000", "--parallel"])).toEqual([]);
});

test("a pass-through all run keeps the browser files sequential", () => {
  // `all` with a flag is one discovery pass, but the browser files still contend for one machine.
  expect(runPlan("all", [], ["--retry=2"])).toEqual({ files: [], parallel: false });
});

test("a filter drops the mode's file list so Bun discovers what it names", () => {
  const files = ["test/a.test.ts", "test/b.page.test.ts"];
  // A list plus a positional runs every listed file and drops the filter, so the list has to go.
  expect(runPlan("e2e-rest", files, ["subagentsCard"])).toEqual({ files: [], parallel: false });
  expect(runPlan("e2e", files, ["test/b"])).toEqual({ files: [], parallel: false });
  expect(runPlan("unit", files, ["gateway"])).toEqual({ files: [], parallel: true });

  // Flags change how the mode's files run, not which: `-t` still filters names within them.
  expect(runPlan("e2e-rest", files, ["--retry=2"])).toEqual({ files, parallel: false });
  expect(runPlan("unit", files, ["-t", "the card lists"])).toEqual({ files, parallel: true });
  expect(runPlan("unit", files, [])).toEqual({ files, parallel: true });
});

test("a Bun older than engines.bun is refused, naming the fix", () => {
  expect(bunVersionProblem("1.4.4", ">=1.4.4")).toBeUndefined();
  expect(bunVersionProblem("1.5.0", ">=1.4.4")).toBeUndefined();
  expect(bunVersionProblem("1.3.14", ">=1.4.4")).toBe(
    "bun 1.3.14 does not satisfy package.json engines.bun (>=1.4.4): run `bun upgrade`",
  );
  // No requirement declared: any Bun runs.
  expect(bunVersionProblem("1.3.14", undefined)).toBeUndefined();
});

test("--repeat is the runner's flag, not Bun's, and a malformed count is refused", () => {
  expect(repeatOf([])).toBe(1);
  expect(repeatOf(["--repeat=5"])).toBe(5);
  expect(repeatOf(["--repeat=0"])).toBeUndefined();
  expect(repeatOf(["--repeat=two"])).toBeUndefined();
  expect(withoutRepeat(["-t", "a name", "--repeat=3", "test/a.test.ts"])).toEqual([
    "-t",
    "a name",
    "test/a.test.ts",
  ]);
});
