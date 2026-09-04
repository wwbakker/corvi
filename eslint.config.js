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
 * `import type` is exempt (`allowTypeImports`): those are erased at compile time by
 * `verbatimModuleSyntax` and never reach the bundle, which is how `SettingsPage.tsx` reads
 * `Config`'s shape from `config.ts` without pulling in the `az`/`gh`/`jira` CLI calls that live
 * beside it.
 *
 * Everything else one level up from `src/web/` is backend: it shells out to CLIs, touches the
 * filesystem, or both. `branch.ts` and `deployConventions.ts` are the exceptions — pure string
 * logic with nothing backend about them, kept outside `src/web/` only because both the server
 * and the browser need the same answer (see their own doc comments).
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", "assets/**", "shots/**", "scripts/**"],
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
                "!../types.ts",
                "!../branch.ts",
                "!../deployConventions.ts",
                "../integrations/*",
              ],
              message:
                "src/web is the browser bundle: only import backend modules (CLI/fs code such as " +
                "deployments.ts, config.ts, azure.ts, sh.ts, ...) with `import type`, which is " +
                "erased before the bundle sees it. For a value both sides need, share it through " +
                "a pure module next to branch.ts / deployConventions.ts instead.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
