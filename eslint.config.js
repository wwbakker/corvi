import tseslint from "typescript-eslint";

/**
 * Explicit function types and source-layout import guards. These rules do not yet enforce
 * the workspace dependency graph in docs/guides/architecture.md. Keep their protections until
 * package-boundary and bundle checks replace them (docs/plans/architecture-refactor.md).
 * Patterns match import specifiers, not resolved files; type-only imports are currently exempt.
 */

/**
 * The server trees a browser half may not import by value, as specifiers relative to it. `up` is
 * the path from the half's directory back to `src/`: `../` from the module-root halves
 * `src/app-root/**` and `src/wizard/**`, `../../` from `src/<module>/client/**`. `extra`
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
  // The extension host's client contract is browser code that lives under extension-host/ by
  // design: the host owns it, not a module, so a browser half may import this one file by
  // value. Its parent directory is re-included first (a file cannot be re-admitted while every
  // parent is excluded), then its contents are restricted again and the one file re-admitted.
  `!${up}extension-host`,
  `${up}extension-host/**`,
  `!${up}extension-host/client.tsx`,
  `${up}extensions/**`,
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
          "a browser half (src/app-root/**, src/wizard/** or src/<module>/client/**) " +
          "may only import server " +
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
      "src/**/*.{ts,tsx}",
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
    // The page's composition root: everything here is browser code except `routes.ts` and
    // `client.ts` — the server halves that build the page and serve it (icons, assets and the
    // fallback) — so the browser boundary skips them.
    files: ["src/app-root/**/*.{ts,tsx}"],
    ignores: ["src/app-root/routes.ts", "src/app-root/client.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../", ["./routes.ts"]),
    },
  },
  {
    files: ["src/*/client/**/*.{ts,tsx}"],
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
    // `src/` like `src/app-root/**`, so backend modules are `../` away and there is no sibling
    // server directory to name.
    files: ["src/wizard/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../", ["./routes.ts"]),
    },
  },
  {
    // An extension's browser code is its `client.tsx` and the `.tsx` siblings beside it (the
    // shared pure `.ts` files are vocabulary, not a half). The extension's server half shares
    // the directory as `index.ts`, `server.ts` and their `.ts` helpers; the generic
    // `${up}*/server/**` catches a `server/` directory but not the `server.ts` file, so both
    // halves are named explicitly as sibling specifiers.
    files: ["src/extensions/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../../", ["./index.ts", "./server.ts"]),
    },
  },
  {
    files: ["src/extension-host/client.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The host's browser contract is browser code under extension-host/ by design (see
      // serverImports), and the rule that keeps it one has to cover it too.
      "no-restricted-imports": browserBoundary("../", ["./routes.ts"]),
    },
  },
  {
    files: ["src/domain/**/*.{ts,tsx}"],
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
    files: ["src/**/model.ts"],
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
