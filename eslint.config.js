import tseslint from "typescript-eslint";

/**
 * The one rule this exists to enforce: `src/web/**` is the browser bundle, and importing a
 * backend module into it does not fail loudly — Bun's HTML-import bundler pulls it in quietly,
 * and the first sign of trouble is an unrelated page timing out in a WebKit test, minutes later
 * and three files away from the mistake.
 *
 * Deliberately narrow rather than a general-purpose recommended config: `tsc --noEmit` already
 * checks types, and turning on style/correctness rules across a codebase that was never linted
 * would make this file about a hundred pre-existing warnings instead of about the one mistake it
 * exists to catch. If this grows into more than the import boundary, widen it deliberately.
 *
 * The other rule set here is explicit return types everywhere (follow-up item 3):
 * `explicit-module-boundary-types` for exported surfaces and `explicit-function-return-type` for
 * inner functions, with expressions exempt so inline callbacks do not need a return annotation.
 * Return types are part of the contract a caller reads; inference across a module boundary turns a
 * signature change into a silent one. Its `files` are broad because the rule applies to every
 * TypeScript source in the repo, while the import-boundary block below stays a separate, narrower
 * object so the shared parser setup cannot accidentally weaken it.
 *
 * `import type` is exempt (`allowTypeImports`): those are erased at compile time by
 * `verbatimModuleSyntax` and never reach the bundle, which is how `SettingsPage.tsx` reads
 * `Config`'s shape from `config.ts` without pulling in the `az`/`gh`/`jira` CLI calls that live
 * beside it.
 *
 * Everything else outside `src/web/` that is not the pure domain is backend: it shells out to
 * CLIs, touches the filesystem, or both. `src/core/domain/` is the structural exception — pure
 * vocabulary and pure operations (no `node:*`, no `Bun.*`, no Effect runtime) that both the
 * server and the browser need, importable by value from `src/web/**`. A module's pure `model.ts`
 * joins it as the modules land, so the rule allows both. The patterns are relative to
 * `src/web/`, and the group restricts every server tree — the top-level files, `integrations/`,
 * the built-ins' server halves, `routes/`, `effect/`, `schemas/` and all of `core/` — then
 * re-includes `core/domain/` and any module's `model.ts`. Put a new shared vocabulary module in
 * `src/core/domain/`, not next to the server.
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", "assets/**", "shots/**"],
  },
  {
    files: [
      "src/**/*.{ts,tsx}",
      "scripts/**/*.ts",
      "test/**/*.{ts,tsx}",
      "pi/**/*.ts",
    ],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowConciseArrowFunctionExpressionsStartingWithVoid: true,
        },
      ],
    },
  },
  {
    files: ["src/web/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../*.ts",
                "../integrations/**",
                "../extensions/**/*.ts",
                "../routes/**",
                "../effect/**",
                "../schemas/**",
                "../core/**",
                "!../core/domain",
                "!../core/domain/**",
                "!../**/model.ts",
              ],
              message:
                "src/web is the browser bundle: server modules (CLI/fs code such as config.ts, " +
                "sh.ts, azure.ts, ...) may only be imported with `import type`, which is erased " +
                "before the bundle sees it. The pure domain under src/core/domain/ (and a " +
                "module's model.ts) is importable by value; put new shared vocabulary there.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
