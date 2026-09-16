import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTooling, rewritePaths, TOOLING } from "../src/capabilities/os.ts";
import { runEffect, runSh } from "./helpers.ts";

/**
 * A new worktree has none of the IDE's state, because none of it is in git. Corvi copies it in
 * rather than making you import the project again — and a copy with stale paths still in it is
 * worse than no copy at all: a build server pointed at the main checkout would build the wrong
 * code from the right-looking project.
 */
let tmp: string;
let repo: string;
let tree: string;

/** A real checkout, because what may be copied is a question only git can answer — and it is
 * asked of the worktree, which is the thing that has to stay clean. */
async function checkout(path: string, ignores: string[]): Promise<void> {
  await mkdir(path, { recursive: true });
  await runSh(["git", "init", "-q", "-b", "main", path]);
  await writeFile(join(path, ".gitignore"), `${ignores.join("\n")}\n`);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-tooling-"));
  repo = join(tmp, "example-api");
  tree = join(tmp, "PROJ-123", "example-api");
  await checkout(repo, [".idea/", ".bsp/"]);
  await mkdir(join(repo, ".idea"), { recursive: true });
  await mkdir(join(repo, ".bsp"), { recursive: true });
  await checkout(tree, [".idea/", ".bsp/"]);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("a path is rewritten where it is a path, not where it is a prefix", () => {
  const from = "/repos/example-api";
  const text = [
    `"workspaceDir": "${from}"`,
    `"src": "${from}/src/main"`,
    `"other": "${from}-client/src"`,
    `"nested": "${from}.backup/x"`,
  ].join("\n");
  const rewritten = rewritePaths(text, from, "/changes/PROJ-123/example-api");

  expect(rewritten).toContain('"workspaceDir": "/changes/PROJ-123/example-api"');
  expect(rewritten).toContain('"src": "/changes/PROJ-123/example-api/src/main"');
  // The sibling repository and the backup directory are other directories entirely.
  expect(rewritten).toContain(`"other": "${from}-client/src"`);
  expect(rewritten).toContain(`"nested": "${from}.backup/x"`);
});

test("IDE state is copied into the worktree with its paths pointing at the worktree", async () => {
  await writeFile(join(repo, ".bsp", "scala.json"), JSON.stringify({ argv: [`${repo}/cli/x.sc`] }));
  await writeFile(
    join(repo, ".idea", "workspace.xml"),
    `<project><option value="${repo}/build" /></project>`,
  );

  const copied = await runEffect(copyTooling(repo, tree, TOOLING));

  expect(copied.sort()).toEqual([".bsp", ".idea"]);
  expect(await readFile(join(tree, ".bsp", "scala.json"), "utf8")).toBe(
    JSON.stringify({ argv: [`${tree}/cli/x.sc`] }),
  );
  expect(await readFile(join(tree, ".idea", "workspace.xml"), "utf8")).toContain(
    `value="${tree}/build"`,
  );
});

test("what the worktree already has is left alone, and binary files survive the copy", async () => {
  const fresh = join(tmp, "second", "example-api");
  await checkout(fresh, [".idea/", ".bsp/"]);
  await mkdir(join(fresh, ".idea"), { recursive: true });
  await writeFile(join(fresh, ".idea", "workspace.xml"), "mine");
  const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]);
  await writeFile(join(repo, ".idea", "icon.png"), icon);

  const copied = await runEffect(copyTooling(repo, fresh, TOOLING));

  // .idea exists there already: the IDE owns it from creation onwards.
  expect(copied).toEqual([".bsp"]);
  expect(await readFile(join(fresh, ".idea", "workspace.xml"), "utf8")).toBe("mine");

  const second = join(tmp, "third", "example-api");
  await checkout(second, [".idea/", ".bsp/"]);
  await runEffect(copyTooling(repo, second, TOOLING));
  expect(Buffer.from(await readFile(join(second, ".idea", "icon.png")))).toEqual(icon);
});

test("a repository without any of it is not a failure", async () => {
  const bare = join(tmp, "empty-repo");
  const target = join(tmp, "empty-tree");
  await checkout(bare, []);
  await checkout(target, [".idea/"]);

  expect(await runEffect(copyTooling(bare, target, TOOLING))).toEqual([]);
});

test("only what git ignores is copied, or the worktree is dirty from the moment it exists", async () => {
  // An untracked .idea is not cosmetic: the worktree counts as dirty for ever, so it cannot be
  // removed, and the review tab offers somebody's IDE settings up for committing.
  const committed = join(tmp, "commits-its-idea");
  const target = join(tmp, "commits-its-idea-tree");
  await checkout(committed, [".bsp/"]);
  await mkdir(join(committed, ".idea"), { recursive: true });
  await mkdir(join(committed, ".bsp"), { recursive: true });
  await writeFile(join(committed, ".idea", "workspace.xml"), "<p/>");
  await checkout(target, [".bsp/"]);

  expect(await runEffect(copyTooling(committed, target, TOOLING))).toEqual([".bsp"]);
});
