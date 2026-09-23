import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";

/**
 * The languages a fenced code block may name, for the editor to highlight inside the fence: the
 * ones plans actually fence — JSON, JavaScript/TypeScript, YAML, HTML, CSS and shell.
 *
 * The page is one bundle with no runtime imports (`test/bundle.test.ts`), so every language here
 * is statically bundled and this list is the bundle's weight: add to it deliberately. A fence
 * naming anything else, or nothing, stays one plain tone. `@codemirror/language-data` is
 * avoided: its lazy loaders would all land in the one bundle anyway.
 *
 * The supports are constructed here rather than loaded on demand — they are in the bundle either
 * way, and a constructed support is used on the fence's first parse, so code is colored the
 * moment it is drawn rather than in the moment after.
 */
export const fencedCodeLanguages: readonly LanguageDescription[] = [
  LanguageDescription.of({ name: "json", support: json() }),
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "mjs", "cjs", "node"],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: "typescript",
    alias: ["ts", "mts", "cts", "tsx"],
    support: javascript({ typescript: true, jsx: true }),
  }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], support: yaml() }),
  LanguageDescription.of({ name: "html", alias: ["htm"], support: html() }),
  LanguageDescription.of({ name: "css", support: css() }),
  // No Lezer grammar for shell exists; the stream mode from the legacy set is what CodeMirror
  // has, and it colors sh/bash well enough to read as code.
  LanguageDescription.of({
    name: "bash",
    alias: ["sh", "shell", "zsh"],
    support: new LanguageSupport(StreamLanguage.define(shell)),
  }),
];
