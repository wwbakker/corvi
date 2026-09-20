import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkArchitecture } from "../scripts/architecture.ts";
import { runSh, testTempDir } from "./helpers.ts";

interface FixturePackage {
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
  readonly files: Record<string, string>;
}

interface FixtureGraph {
  readonly packages: Readonly<Record<string, { readonly dependsOn: readonly string[]; readonly external?: readonly string[] }>>;
}

const contractsPackage = (
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
): FixturePackage => ({
  dir: "contracts",
  manifest: {
    name: "@corvi/contracts",
    version: "0.0.0",
    exports: { "./changes": "./src/changes.ts" },
    dependencies: { effect: "catalog:" },
    ...manifest,
  },
  files,
});

const changesPackage = (
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
): FixturePackage => ({
  dir: "changes",
  manifest: {
    name: "@corvi/changes",
    version: "0.0.0",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@corvi/contracts": "workspace:*" },
    ...manifest,
  },
  files,
});

const graph: FixtureGraph = {
  packages: {
    "@corvi/contracts": { dependsOn: [], external: ["effect"] },
    "@corvi/changes": { dependsOn: ["@corvi/contracts"] },
  },
};

const writeFixture = async (
  label: string,
  fixtureGraph: FixtureGraph,
  packages: readonly FixturePackage[],
): Promise<string> => {
  const root = await testTempDir(`architecture-${label}`);
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }, null, 2) + "\n",
  );
  await Bun.write(join(root, "architecture.json"), JSON.stringify(fixtureGraph, null, 2) + "\n");
  for (const pkg of packages) {
    const dir = join(root, "packages", pkg.dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(join(dir, "package.json"), JSON.stringify(pkg.manifest, null, 2) + "\n");
    for (const [name, contents] of Object.entries(pkg.files)) {
      const file = join(dir, "src", name);
      await mkdir(dirname(file), { recursive: true });
      await Bun.write(file, contents);
    }
  }
  return root;
};

const problemsOf = (root: string): string => checkArchitecture(root).join("\n");

test("this repository's own graph has no violations", () => {
  expect(checkArchitecture(resolve(import.meta.dir, ".."))).toEqual([]);
});

test("a declared, allowed workspace import passes", async () => {
  const root = await writeFixture("positive", graph, [
    contractsPackage({ "changes.ts": "export const x = 1;\n" }),
    changesPackage({ "index.ts": 'import { x } from "@corvi/contracts/changes";\nexport const y = x;\n' }),
  ]);
  expect(checkArchitecture(root)).toEqual([]);
});

test("an undeclared workspace dependency fails", async () => {
  const root = await writeFixture("undeclared", graph, [
    contractsPackage({ "changes.ts": "export const x = 1;\n" }),
    changesPackage({ "index.ts": 'import { x } from "@corvi/contracts/changes";\n' }, { dependencies: {} }),
  ]);
  expect(problemsOf(root)).toContain("undeclared workspace dependency");
});

test("a forbidden workspace edge fails even when declared", async () => {
  const root = await writeFixture("reverse", graph, [
    contractsPackage({ "changes.ts": 'import "@corvi/changes";\n' }, { dependencies: { effect: "catalog:", "@corvi/changes": "workspace:*" } }),
    changesPackage({ "index.ts": "export const y = 1;\n" }),
  ]);
  expect(problemsOf(root)).toContain("workspace dependency not allowed: @corvi/contracts -> @corvi/changes");
});

test("a workspace subpath that is not exported fails", async () => {
  const root = await writeFixture("deep", graph, [
    contractsPackage({ "changes.ts": "export const x = 1;\n" }),
    changesPackage({ "index.ts": 'import { x } from "@corvi/contracts/src/changes.ts";\n' }),
  ]);
  expect(problemsOf(root)).toContain("deep import not exported by @corvi/contracts");
});

test("a relative import escaping the package fails", async () => {
  const root = await writeFixture("escape", graph, [
    contractsPackage({ "changes.ts": "export const x = 1;\n" }),
    changesPackage({ "index.ts": 'import { x } from "../../contracts/src/changes.ts";\n' }),
  ]);
  expect(problemsOf(root)).toContain("relative import escapes the package");
});

test("an undeclared external import fails", async () => {
  const root = await writeFixture("external", graph, [
    contractsPackage({ "changes.ts": "export const x = 1;\n" }),
    changesPackage({ "index.ts": 'import "zod";\n' }),
  ]);
  expect(problemsOf(root)).toContain("undeclared external dependency: zod");
});

test("contracts may not import Node built-ins", async () => {
  const root = await writeFixture("builtin", graph, [
    contractsPackage({ "changes.ts": 'import "node:fs";\n' }),
    changesPackage({ "index.ts": "export const y = 1;\n" }),
  ]);
  expect(problemsOf(root)).toContain("may not import a Node built-in: node:fs");
});

test("contracts may not import an external outside its allowlist", async () => {
  const root = await writeFixture("allowlist", graph, [
    contractsPackage({ "changes.ts": 'import "zod";\n' }, { dependencies: { effect: "catalog:", zod: "^3.0.0" } }),
    changesPackage({ "index.ts": "export const y = 1;\n" }),
  ]);
  expect(problemsOf(root)).toContain("external import not on the allowlist: zod");
});

test("a configured dependency cycle fails", async () => {
  const cyclic: FixtureGraph = {
    packages: {
      "@corvi/a": { dependsOn: ["@corvi/b"] },
      "@corvi/b": { dependsOn: ["@corvi/a"] },
    },
  };
  const root = await writeFixture("cycle", cyclic, [
    { dir: "a", manifest: { name: "@corvi/a", version: "0.0.0" }, files: { "index.ts": "export const a = 1;\n" } },
    { dir: "b", manifest: { name: "@corvi/b", version: "0.0.0" }, files: { "index.ts": "export const b = 1;\n" } },
  ]);
  expect(problemsOf(root)).toContain("dependency cycle");
});

test("type-only and dynamic imports count as dependencies", async () => {
  const root = await writeFixture("kinds", graph, [
    contractsPackage({ "changes.ts": "export const x = 1;\n" }),
    changesPackage(
      {
        "index.ts":
          'import type { Change } from "@corvi/contracts/changes";\nconst loaded = await import("@corvi/contracts/changes");\nexport const y = [loaded];\n',
      },
      { dependencies: {} },
    ),
  ]);
  const undeclared = checkArchitecture(root).filter((problem) => problem.includes("undeclared workspace dependency"));
  expect(undeclared.length).toBe(2);
});

test("the CLI exits zero on this repository", async () => {
  const result = await runSh(["bun", "scripts/architecture.ts"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("no violations");
});

test("the CLI exits nonzero with violations", async () => {
  const root = await writeFixture("cli", graph, [
    contractsPackage({ "changes.ts": "export const x = 1;\n" }),
    changesPackage({ "index.ts": 'import { x } from "@corvi/contracts/changes";\n' }, { dependencies: {} }),
  ]);
  const result = await runSh(["bun", "scripts/architecture.ts", root]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("undeclared workspace dependency");
});
