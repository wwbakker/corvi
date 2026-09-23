/** Lint must cover every workspace's sources.
 *
 * The eslint `files` globs decide what `bun run lint` checks, so extracting a package into a new
 * workspace must not silently exempt it: every workspace package has to match at least one
 * configured glob. This is the lint-side counterpart of the boundaries check.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import config from "../eslint.config.js";

const root = join(import.meta.dir, "..");

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One glob as an anchored pattern: a double-star slash spans directories including none, `*`
 * and `?` stay inside a path segment, `{a,b}` alternates literals, everything else matches
 * itself. */
const globSource = (glob: string): string => {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string;
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end < 0) {
        source += "\\{";
      } else {
        const alternatives = glob.slice(index + 1, end).split(",").map(escapeRegex);
        source += `(?:${alternatives.join("|")})`;
        index = end;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  return `^${source}$`;
};

/** The union of the `files` globs the configured blocks declare. A block without `files` (the
 * global ignore) matches nothing and contributes no coverage. */
const lintPatterns: readonly RegExp[] = config.flatMap((block) => {
  const globs = typeof block.files === "string" ? [block.files] : Array.isArray(block.files) ? block.files : [];
  return globs.filter((glob): glob is string => typeof glob === "string").map((glob) => new RegExp(globSource(glob)));
});

/** The workspace groups named in the root manifest's `workspaces` patterns. */
const workspaceGroups = (): readonly string[] => {
  const manifest = readJSON<{ readonly workspaces?: unknown }>(join(root, "package.json"));
  const workspaces = manifest.workspaces;
  const entries = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object" && "packages" in workspaces
      ? (workspaces as { readonly packages?: unknown }).packages
      : undefined;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is string => typeof entry === "string");
};

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Every package directory the workspace patterns name. */
const workspacePackages = (): readonly string[] => {
  const dirs: string[] = [];
  for (const pattern of workspaceGroups()) {
    const star = pattern.lastIndexOf("*");
    if (star < 0) continue;
    const group = join(root, pattern.slice(0, star));
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(group, entry.name));
    }
  }
  return dirs;
};

/** The package's TypeScript sources, skipping build and dependency directories. */
const sourceFiles = (packageDir: string): readonly string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(packageDir);
  return files;
};

test("every workspace package's sources match an eslint files glob", () => {
  expect(lintPatterns.length).toBeGreaterThan(0);
  const uncovered = workspacePackages().filter(
    (packageDir) =>
      !sourceFiles(packageDir).some((file) => {
        const path = relative(root, file);
        return lintPatterns.some((pattern) => pattern.test(path));
      }),
  );
  expect(uncovered).toEqual([]);
});
