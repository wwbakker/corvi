import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { shell } from "@codemirror/legacy-modes/mode/shell";

/**
 * The languages a fenced code block may name, for the editor to highlight inside the fence: the
 * ones plans actually fence — data formats, web, the JVM's, scripts and shell.
 *
 * The page is one bundle with no runtime imports (`test/bundle.test.ts`), so every language here
 * is statically bundled and this list is the bundle's weight: add to it deliberately. A fence
 * naming anything else, or nothing, stays one plain tone. `@codemirror/language-data` is
 * avoided: its lazy loaders would all land in the one bundle anyway.
 *
 * The supports are constructed here rather than loaded on demand — they are in the bundle either
 * way, and a constructed support is used on the fence's first parse, so code is colored the
 * moment it is drawn rather than in the moment after. A Lezer grammar exists for some; Kotlin
 * and Scala (like shell) ride `@codemirror/legacy-modes`' stream parsers — there is no grammar
 * for either — which color a little more coarsely but read as code.
 */
export const fencedCodeLanguages: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "bash",
    alias: ["sh", "shell", "zsh"],
    support: new LanguageSupport(StreamLanguage.define(shell)),
  }),
  LanguageDescription.of({ name: "css", support: css() }),
  LanguageDescription.of({ name: "html", alias: ["htm"], support: html() }),
  LanguageDescription.of({ name: "java", support: java() }),
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "mjs", "cjs", "node"],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({ name: "json", support: json() }),
  LanguageDescription.of({
    name: "kotlin",
    alias: ["kt", "kts"],
    support: new LanguageSupport(StreamLanguage.define(kotlin)),
  }),
  LanguageDescription.of({ name: "python", alias: ["py"], support: python() }),
  LanguageDescription.of({
    name: "scala",
    alias: ["sc", "sbt"],
    support: new LanguageSupport(StreamLanguage.define(scala)),
  }),
  LanguageDescription.of({ name: "sql", support: sql() }),
  LanguageDescription.of({
    name: "typescript",
    alias: ["ts", "mts", "cts", "tsx"],
    support: javascript({ typescript: true, jsx: true }),
  }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], support: yaml() }),
];
