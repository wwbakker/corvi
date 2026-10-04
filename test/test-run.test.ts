import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  discoverGroups,
  discoverTestFiles,
  filesForMode,
  importsBrowserAtRuntime,
  isMode,
  isTerminalGroup,
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
  expect(filesForMode("all", groups)).toEqual([
    ...groups.unit,
    ...groups.e2eTerminal,
    ...groups.e2eRest,
  ]);
});

test("the modes are the documented set; a typo is not a mode", () => {
  for (const mode of ["all", "unit", "e2e", "e2e-terminal", "e2e-rest"]) {
    expect(isMode(mode)).toBe(true);
  }
  expect(isMode("e2e-all")).toBe(false);
  expect(isMode("")).toBe(false);
  expect(isMode(undefined)).toBe(false);
});

test("classification is the line-oriented Playwright import", () => {
  expect(importsBrowserAtRuntime('import { chromium } from "playwright";')).toBe(true);
  expect(importsBrowserAtRuntime('  import { chromium, webkit } from "playwright";')).toBe(true);
  expect(importsBrowserAtRuntime('import {\n  chromium,\n} from "playwright";')).toBe(false);
  expect(importsBrowserAtRuntime('import type { Browser } from "playwright";')).toBe(false);
  expect(importsBrowserAtRuntime('import { chromium } from "playwright-core";')).toBe(false);
  expect(isTerminalGroup("test/terminal.test.ts")).toBe(true);
  expect(isTerminalGroup("test/terminalAcceptance.test.ts")).toBe(true);
  expect(isTerminalGroup("test/pages.test.ts")).toBe(false);
  expect(classify("test/pages.test.ts", 'import { chromium } from "playwright";')).toBe("e2e-rest");
  expect(classify("test/terminal.test.ts", 'import { chromium } from "playwright";')).toBe(
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
    writeFileSync(
      join(root, "test/terminalThing.test.ts"),
      'import { chromium } from "playwright";\n',
    );
    writeFileSync(join(root, "test/other.test.ts"), "// not a browser file\n");

    const groups = discoverGroups(root);
    expect(groups.e2eTerminal).toEqual(["test/terminalThing.test.ts"]);
    expect(groups.e2eRest).toEqual(["test/single.test.ts"]);
    expect(groups.unit).toEqual([
      "test/multi.test.ts",
      "test/other.test.ts",
      "test/type-only.test.ts",
    ]);
    expect(groups.e2e).toEqual(["test/terminalThing.test.ts", "test/single.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
