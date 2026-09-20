/** Checked workspace dependency graph.
 *
 * The allowed graph lives in `architecture.json` at the root of the tree being checked; a fixture
 * root may carry its own. This checks configured edges, declared dependencies, deep imports,
 * relative escapes, external imports, and cycles. Type-only and dynamic imports count.
 *
 * `bun run boundaries` checks this repository; `checkArchitecture(root)` returns violations so
 * tests can exercise negative fixtures.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import * as ts from "typescript"

interface GraphRule {
  readonly dependsOn: readonly string[]
  readonly external?: readonly string[]
}

interface ArchitectureConfig {
  readonly packages: Readonly<Record<string, GraphRule>>
}

interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly dependencies: ReadonlySet<string>
  readonly exports: ReadonlySet<string>
  readonly sources: readonly string[]
}

interface ImportedModule {
  readonly specifier: string
  readonly line: number
}

const builtins: ReadonlySet<string> = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

const workspacePatterns = (root: string): readonly string[] => {
  const manifest = readJson<{ readonly workspaces?: unknown }>(join(root, "package.json"))
  const workspaces = manifest.workspaces
  const entries = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object" && "packages" in workspaces
      ? (workspaces as { readonly packages?: unknown }).packages
      : undefined
  if (!Array.isArray(entries)) return []
  return entries.filter((entry): entry is string => typeof entry === "string")
}

const findPackageDirs = (root: string, patterns: readonly string[]): readonly string[] => {
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    const star = pattern.lastIndexOf("*")
    const base = resolve(root, star < 0 ? pattern : pattern.slice(0, star))
    if (!existsSync(base)) continue
    if (star < 0) {
      if (existsSync(join(base, "package.json"))) dirs.add(base)
      continue
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      if (existsSync(join(dir, "package.json"))) dirs.add(dir)
    }
  }
  return [...dirs]
}

const collectSources = (dir: string): readonly string[] => {
  const src = join(dir, "src")
  if (!existsSync(src)) return []
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(path)
    }
  }
  walk(src)
  return files
}

const readPackage = (dir: string): WorkspacePackage => {
  const manifest = readJson<{
    readonly name?: string
    readonly dependencies?: Readonly<Record<string, string>>
    readonly peerDependencies?: Readonly<Record<string, string>>
    readonly optionalDependencies?: Readonly<Record<string, string>>
    readonly exports?: Readonly<Record<string, unknown>>
  }>(join(dir, "package.json"))
  if (!manifest.name) throw new Error(`${join(dir, "package.json")} has no name`)
  return {
    name: manifest.name,
    dir,
    dependencies: new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]),
    exports: new Set(
      Object.keys(manifest.exports ?? {}).map((key) =>
        key === "." ? manifest.name! : `${manifest.name}/${key.replace(/^\.\//, "")}`,
      ),
    ),
    sources: collectSources(dir),
  }
}

const collectImports = (file: string): readonly ImportedModule[] => {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const imports: ImportedModule[] = []
  const add = (node: ts.Node, specifier: string): void => {
    imports.push({
      specifier,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    })
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node, node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node, node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const argument = node.arguments[0]!
      if (ts.isStringLiteral(argument)) add(node, argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return imports
}

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const declared = (pkg: WorkspacePackage, specifier: string): boolean =>
  [...pkg.dependencies].some((name) => specifier === name || specifier.startsWith(`${name}/`))

const allowedExternal = (rule: GraphRule, specifier: string): boolean | undefined => {
  if (!rule.external) return undefined
  return rule.external.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

const isBuiltin = (specifier: string): boolean =>
  builtins.has(specifier) || specifier.startsWith("node:") || specifier.startsWith("bun:")

export const checkArchitecture = (root: string): readonly string[] => {
  const config = readJson<ArchitectureConfig>(join(root, "architecture.json"))
  const packages = findPackageDirs(root, workspacePatterns(root)).map(readPackage)
  const byName = new Map<string, WorkspacePackage>()
  const problems: string[] = []

  for (const pkg of packages) {
    if (byName.has(pkg.name)) problems.push(`${relative(root, pkg.dir)}: duplicate package name ${pkg.name}`)
    byName.set(pkg.name, pkg)
    const rule = config.packages[pkg.name]
    if (!rule) {
      problems.push(`${relative(root, pkg.dir)}: no rule in architecture.json`)
      continue
    }
    for (const target of rule.dependsOn)
      if (!config.packages[target]) problems.push(`architecture.json: ${pkg.name} depends on unknown ${target}`)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const visitPackage = (name: string): void => {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      problems.push(`architecture.json: dependency cycle: ${[...stack, name].join(" -> ")}`)
      return
    }
    visiting.add(name)
    stack.push(name)
    for (const target of config.packages[name]?.dependsOn ?? []) if (byName.has(target)) visitPackage(target)
    stack.pop()
    visiting.delete(name)
    visited.add(name)
  }
  for (const pkg of packages) visitPackage(pkg.name)

  const report = (file: string, imported: ImportedModule, message: string): void => {
    problems.push(`${relative(root, file)}:${imported.line}: ${message}`)
  }

  for (const pkg of packages) {
    const rule = config.packages[pkg.name]
    if (!rule) continue
    for (const file of pkg.sources) {
      for (const imported of collectImports(file)) {
        const specifier = imported.specifier
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier)
          if (!isInside(target, pkg.dir)) report(file, imported, `relative import escapes the package: ${specifier}`)
          continue
        }
        const workspaceTarget = [...byName.values()].find(
          (candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`),
        )
        if (workspaceTarget) {
          if (!declared(pkg, workspaceTarget.name))
            report(file, imported, `undeclared workspace dependency: ${workspaceTarget.name}`)
          if (!rule.dependsOn.includes(workspaceTarget.name))
            report(file, imported, `workspace dependency not allowed: ${pkg.name} -> ${workspaceTarget.name}`)
          const exported =
            workspaceTarget.exports.has(specifier) ||
            [...workspaceTarget.exports].some((entry) => entry.endsWith("/*") && specifier.startsWith(entry.slice(0, -1)))
          if (!exported) report(file, imported, `deep import not exported by ${workspaceTarget.name}: ${specifier}`)
          continue
        }
        if (isBuiltin(specifier)) {
          const local = relative(pkg.dir, file)
          const inNodeAdapter = local.startsWith(`src${sep}node${sep}`)
          if (!inNodeAdapter)
            report(file, imported, `Node built-in imports belong in the node adapter entrypoint: ${specifier}`)
          else if (allowedExternal(rule, specifier) === false)
            report(file, imported, `may not import a Node built-in: ${specifier}`)
          continue
        }
        const allowed = allowedExternal(rule, specifier)
        if (allowed === false) report(file, imported, `external import not on the allowlist: ${specifier}`)
        else if (allowed === undefined && !declared(pkg, specifier))
          report(file, imported, `undeclared external dependency: ${specifier}`)
      }
    }
  }

  return problems
}

const main = (): void => {
  const root = resolve(process.argv[2] ?? process.cwd())
  let problems: readonly string[]
  try {
    problems = checkArchitecture(root)
  } catch (cause) {
    console.error(`architecture: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
    return
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`architecture: ${problem}`)
    console.error(`architecture: ${problems.length} violation(s)`)
    process.exitCode = 1
    return
  }
  console.log("architecture: no violations")
}

if (import.meta.main) main()
