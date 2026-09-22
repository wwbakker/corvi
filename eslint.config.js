import tseslint from "typescript-eslint";

/**
 * Explicit function types and source-layout import guards. The workspace dependency graph in
 * docs/guides/architecture.md is enforced by `bun run boundaries`, and the bundle test keeps
 * Node out of the browser build. These rules additionally guard the browser/server split within
 * an application. Patterns match import specifiers, not resolved files; type-only imports are
 * currently exempt.
 */

/**
 * The server trees a browser half may not import by value, as specifiers relative to it. `up` is
 * the path from the half's directory back to `src/`: `../` from the module-root halves
 * `apps/web/src/app-root/**` and `apps/web/src/wizard/**`, `../../` from `src/<module>/client/**`
 * and the integrations' browser halves. `extra`
 * carries patterns that only make sense at one depth — a client half's own server directory is
 * the sibling `../server/**`, and every browser half's own route table is a sibling specifier
 * (`./routes.ts` at the module root, `../routes.ts` one directory down). The
 * negations re-admit the pure domain, the host's client contract and a module's
 * `model.ts`, and follow the patterns they narrow, which is the order `no-restricted-imports`
 * applies them in.
 */
const serverImports = (up, extra = []) => [
  // A module's route table is server code, even though it sits at the module root.
  `${up}*/routes.ts`,
  ...extra,
  `${up}*/server/**`,
  `${up}capabilities/**`,
  `${up}vendors/**`,
  `!${up}domain`,
  `!${up}domain/**`,
  // The integration host's client contract is browser code that lives under integrations/ by
  // design: the host owns it, not a module, so a browser half may import this one file by
  // value. Its parent directory is re-included first (a file cannot be re-admitted while every
  // parent is excluded), then its contents are restricted again and the one file re-admitted.
  `!${up}integrations`,
  `${up}integrations/**`,
  // An integration's browser half is browser code: the host's client registry imports the
  // included halves directly. A file cannot be re-admitted while every parent is excluded, so
  // its directory is re-admitted first, then the half itself. Everything else under
  // integrations/ — the host's dispatch — stays restricted.
  `!${up}integrations/*`,
  `!${up}integrations/client.tsx`,
  `!${up}integrations/*/client.tsx`,
  `!${up}**/model.ts`,
];

/** The `no-restricted-imports` rule value for one depth of browser half. */
const browserBoundary = (up, extra = []) => [
  "error",
  {
    patterns: [
      {
        group: serverImports(up, extra),
        message:
          "a browser half (apps/web/src/app-root/**, apps/web/src/wizard/**, an integration's " +
          "browser half or src/<module>/client/**) may only import server " +
          "modules with `import type`, which is erased before the bundle sees it. The pure " +
          "domain under src/domain/ (and a module's model.ts) is importable by value; put " +
          "new shared vocabulary there.",
        allowTypeImports: true,
      },
    ],
  },
];

/** The `no-restricted-imports` rule value for one pure domain/model tree. `extra` carries what
 * only that tree additionally refuses — the domain also refuses the error taxonomy, which a
 * `model.ts` is allowed to import. The bare package names go in `paths` (an exact match), not
 * `patterns`: `effect` as a gitignore-style pattern would also match the taxonomy's own
 * `capabilities/effect/errors.ts` path segment. */
const pureBoundary = (extra = []) => [
  "error",
  {
    paths: [
      { name: "effect", message: "domain/** and model.ts are pure: no Effect runtime" },
      { name: "bun", message: "domain/** and model.ts are pure: no Bun.*" },
    ],
    patterns: [
      {
        group: ["node:*", "bun:*", "effect/*", ...extra],
        message:
          "domain/** and a module's model.ts are pure: no node:*, no Bun.*, no Effect runtime. " +
          "A model.ts may import the error taxonomy (capabilities/effect/errors.ts); the domain " +
          "may not.",
      },
    ],
  },
];

export default tseslint.config(
  {
    ignores: ["node_modules/**", "assets/**", "shots/**"],
  },
  {
    files: [
      "apps/server/src/**/*.{ts,tsx}",
      "apps/web/src/**/*.{ts,tsx}",
      "apps/desktop/**/*.{ts,tsx}",
      "integrations/**/*.{ts,tsx}",
      "scripts/**/*.ts",
      "test/**/*.{ts,tsx}",
      "packages/**/*.{ts,tsx}",
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
    // The page's composition root: everything here is browser code.
    files: ["apps/web/src/app-root/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../", ["./routes.ts"]),
    },
  },
  {
    files: ["apps/web/src/*/client/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../../", ["../server/**", "../routes.ts"]),
    },
  },
  {
    // The wizard's browser half sits at the module root (`Wizard.tsx`, with `index.ts` as its
    // barrel) rather than under `client/`, so it needs its own block. It is one level below
    // `src/` like `apps/web/src/app-root/**`, so backend modules are `../` away and there is no
    // sibling server directory to name.
    files: ["apps/web/src/wizard/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../", ["./routes.ts"]),
    },
  },
  {
    // An integration's browser code is its `client.tsx` and the `.tsx` siblings beside it (the
    // shared pure `.ts` files are vocabulary, not a half). A server half sharing the directory
    // would appear as `index.ts`, `server.ts` and their `.ts` helpers; the generic
    // `${up}*/server/**` catches a `server/` directory but not the `server.ts` file, so both
    // are named explicitly as sibling specifiers the half may not import by value.
    files: ["apps/web/src/integrations/*/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../../", ["./index.ts", "./server.ts"]),
    },
  },
  {
    files: ["apps/web/src/integrations/client.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The integration host's browser contract is browser code under integrations/ by design
      // (see serverImports), and the rule that keeps it one has to cover it too.
      "no-restricted-imports": browserBoundary("../", ["./routes.ts"]),
    },
  },
  {
    files: ["apps/server/src/domain/**/*.{ts,tsx}", "apps/web/src/domain/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-imports": pureBoundary(["**/effect/errors.ts"]),
      "no-restricted-globals": [
        "error",
        { name: "Bun", message: "domain/** is pure: no Bun.*" },
        { name: "process", message: "domain/** is pure: no ambient process" },
      ],
    },
  },
  {
    files: ["apps/server/src/**/model.ts", "apps/web/src/**/model.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-imports": pureBoundary(),
      "no-restricted-globals": [
        "error",
        { name: "Bun", message: "model.ts is pure: no Bun.*" },
        { name: "process", message: "model.ts is pure: no ambient process" },
      ],
    },
  },
);
