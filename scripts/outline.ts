/**
 * Print a module's exported surface — names, full types, and doc summaries, every body elided.
 * What a reader (or an agent) needs to work against a module, without paying for its
 * implementation.
 *
 *   bun run outline src/core/domain/change.ts  # one file
 *   bun run outline src/extensions          # a directory: its index.ts, or its .ts files
 *   bun run outline src/core/domain/change.ts src/core/platform/capabilities/sh.ts  # several
 *
 * The types come from the compiler, not from a mirror kept in step by hand: an Effect signature
 * carries the errors and requirements (`Effect<A, E, R>`), so an outline is enough to plan
 * against a module and the implementation is only opened when it is being changed.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** The project's own options, so `./x.ts` imports resolve the way the build resolves them. */
function programFor(files: string[]): ts.Program {
  const configPath = ts.findConfigFile(".", ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("no tsconfig.json found — run from the repository root");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return ts.createProgram(files, { ...parsed.options, noEmit: true });
}

/** The files a path stands for: a file itself, or a directory's index.ts (or its .ts files). */
function filesOf(path: string): string[] {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error(`no such path: ${path}`);
    process.exit(1);
  }
  if (!statSync(abs).isDirectory()) return [abs];
  const index = join(abs, "index.ts");
  if (existsSync(index)) return [index];
  return readdirSync(abs)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .sort()
    .map((name) => join(abs, name));
}

/** The exported statements of one file, in source order, as lines of an outline. */
function outlineOf(source: ts.SourceFile, checker: ts.TypeChecker): string[] {
  const lines: string[] = [];
  const format =
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

  const typeOf = (symbol: ts.Symbol, node: ts.Node): string =>
    checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, node), node, format);

  const docOf = (symbol: ts.Symbol | undefined): string => {
    const text = symbol
      ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
      : "";
    return text
      .split("\n")
      .map((line) => `    ${line}`.trimEnd())
      .join("\n");
  };

  /** `name(params): return`, bodies never involved. */
  const signatureOf = (node: ts.SignatureDeclaration): string => {
    const name = node.name?.getText() ?? "(anonymous)";
    const signature = checker.getSignatureFromDeclaration(node);
    if (!signature) return `${name}(?)`;
    const params = signature.getParameters().map((parameter) => {
      const declaration = parameter.valueDeclaration as ts.ParameterDeclaration | undefined;
      const rest = declaration?.dotDotDotToken ? "..." : "";
      const optional = parameter.flags & ts.SymbolFlags.Optional ? "?" : "";
      // A destructured parameter has no name of its own: the checker calls it `__0`, which
      // tells a reader nothing, so say what it is instead.
      const name = declaration && !ts.isIdentifier(declaration.name) ? "props" : parameter.name;
      return `${rest}${name}${optional}: ${typeOf(parameter, node)}`;
    });
    const typeParams = node.typeParameters?.length
      ? `<${node.typeParameters.map((tp) => tp.getText()).join(", ")}>`
      : "";
    const returns = checker.typeToString(signature.getReturnType(), node, format);
    return `${name}${typeParams}(${params.join(", ")})${returns === "void" ? "" : `: ${returns}`}`;
  };

  const provenance = (node: ts.Node): string => {
    const file = node.getSourceFile();
    return file === source ? "" : `  — from ${relative(dirname(source.fileName), file.fileName)}`;
  };

  const describe = (symbol: ts.Symbol, node: ts.Node): string => {
    if (ts.isVariableDeclaration(node)) return `${node.name.getText()}: ${typeOf(symbol, node)}`;
    if (ts.isFunctionDeclaration(node)) return signatureOf(node);
    if (ts.isMethodDeclaration(node)) return signatureOf(node);
    if (ts.isPropertyDeclaration(node)) return `${node.name.getText()}: ${typeOf(symbol, node)}`;
    return (node as ts.NamedDeclaration).name?.getText() ?? "?";
  };

  /** Print one exported declaration, however it is written, with its doc. A re-export's
   * provenance (`note`) is appended to a single-line signature or set above a multi-line one. */
  const printDeclaration = (
    node: ts.Declaration,
    symbol: ts.Symbol | undefined,
    note = "",
  ): void => {
    const isDefault =
      ts.canHaveModifiers(node) &&
      Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
    if (ts.isVariableDeclaration(node)) {
      lines.push(`export const ${describe(symbol!, node)}${note}`);
    } else if (ts.isFunctionDeclaration(node)) {
      lines.push(`export ${isDefault ? "default " : ""}function ${signatureOf(node)}${note}`);
    } else if (ts.isClassDeclaration(node)) {
      printClass(node, note);
    } else if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (note) lines.push(`// ${note.trim().replace(/^— /, "")}`);
      lines.push(node.getText());
    } else {
      lines.push(`export ${node.getText().split("\n")[0]!.trimEnd()}${note}`);
    }
    const doc = docOf(symbol);
    if (doc) lines.push(doc);
  };

  const printClass = (node: ts.ClassDeclaration, note = ""): void => {
    const name = node.name?.getText() ?? "?";
    const typeParams = node.typeParameters?.length
      ? `<${node.typeParameters.map((tp) => tp.getText()).join(", ")}>`
      : "";
    const heritage = (node.heritageClauses ?? [])
      .map(
        (clause) =>
          ` ${clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"} ` +
          clause.types.map((type) => type.getText()).join(", "),
      )
      .join("");
    lines.push(`export class ${name}${typeParams}${heritage}${note}`);
    const doc = docOf(checker.getSymbolAtLocation(node.name ?? node));
    if (doc) lines.push(doc);
    for (const member of node.members) {
      const flags = ts.getCombinedModifierFlags(member);
      if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      if (!member.name && !ts.isConstructorDeclaration(member)) continue;
      if (ts.isConstructorDeclaration(member)) {
        lines.push(`    constructor(args)`);
        continue;
      }
      if (ts.isMethodDeclaration(member)) {
        lines.push(`    ${signatureOf(member)}`);
        continue;
      }
      const symbol = checker.getSymbolAtLocation(member.name!);
      if (symbol) lines.push(`    ${describe(symbol, member)}`);
    }
  };

  for (const statement of source.statements) {
    // `export { … } from` and `export default` are statements of their own, not modified ones.
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported =
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      // A re-export from the project is worth resolving to the original signature; one from a
      // dependency is not (the outline is for this codebase).
      const local = !specifier || specifier.startsWith(".");
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const symbol = checker.getSymbolAtLocation(element.name);
          const target =
            symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          const node = local ? target?.declarations?.[0] : undefined;
          if (!target || !node) {
            lines.push(`export { ${element.name.getText()} }${specifier ? ` from "${specifier}"` : ""}`);
            continue;
          }
          printDeclaration(node, target, provenance(node));
        }
        continue;
      }
      if (clause && ts.isNamespaceExport(clause)) {
        lines.push(`export * as ${clause.name.getText()} from "${specifier}"`);
        continue;
      }
      lines.push(`export * from "${specifier}"`);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        printDeclaration(declaration, checker.getSymbolAtLocation(declaration.name));
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      printDeclaration(statement, checker.getSymbolAtLocation(statement.name));
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      printDeclaration(statement, checker.getSymbolAtLocation(statement.name!));
      continue;
    }

    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      printDeclaration(statement, checker.getSymbolAtLocation(statement.name!));
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const expression = statement.expression;
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        const target =
          symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const node = target?.declarations?.[0];
        if (target && node) {
          lines.push(`export default ${expression.getText()}: ${typeOf(target, node)}`);
          const doc = docOf(target);
          if (doc) lines.push(doc);
        } else {
          lines.push(`export default ${expression.getText()}`);
        }
      } else if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        lines.push(`export default ${signatureOf(expression)}`);
      } else if (ts.isSatisfiesExpression(expression)) {
        // An extension module, almost always: its shape is the Extension type plus the surfaces
        // it actually declares, which is the whole point of an outline for one.
        const inner = expression.expression;
        const target = expression.type.getText();
        if (ts.isObjectLiteralExpression(inner)) {
          const keys = inner.properties.map((property) => property.name?.getText() ?? "…");
          lines.push(`export default { ${keys.join(", ")} } satisfies ${target}`);
        } else {
          lines.push(`export default { … } satisfies ${target}`);
        }
      } else {
        lines.push(`export default ${expression.getText().split("\n")[0]!.trimEnd()}`);
      }
      continue;
    }
  }

  return lines;
}

// --- run ------------------------------------------------------------------------------------

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: bun run outline <file|directory> [more...]");
  process.exit(1);
}

const files = paths.flatMap(filesOf);
const program = programFor(files);
const checker = program.getTypeChecker();

for (const file of files) {
  const source = program.getSourceFile(file);
  if (!source) {
    console.error(`not part of the project: ${file}`);
    continue;
  }
  const lines = outlineOf(source, checker);
  console.log(`# ${relative(process.cwd(), file)}\n`);
  console.log(lines.length ? lines.join("\n\n") : "(no exports)");
  console.log();
}
