import tseslint from "typescript-eslint";

/**
 * The one rule this exists to enforce: the browser's own code — `src/frontend/**`, every module's
 * `client/` half and a submodule's — is bundled into the page, and importing a backend module
 * into it does not fail
 * loudly. Bun's HTML-import bundler pulls the module in quietly, and the first sign of trouble is
 * an unrelated page timing out in a WebKit test, minutes later and three files away from the
 * mistake.
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
 * TypeScript source in the repo, while the import-boundary blocks below stay separate, narrower
 * objects so the shared parser setup cannot accidentally weaken them.
 *
 * `import type` is exempt (`allowTypeImports`): those are erased at compile time by
 * `verbatimModuleSyntax` and never reach the bundle, which is how `SettingsPage.tsx` reads
 * `Config`'s shape from `config.ts` without pulling in the `az`/`gh`/`jira` CLI calls that live
 * beside it.
 *
 * Everything else outside the browser halves that is not the pure domain is backend: it shells
 * out to CLIs, touches the filesystem, or both. `src/core/domain/` is the structural exception —
 * pure vocabulary and pure operations (no `node:*`, no `Bun.*`, no Effect runtime) that both the
 * server and the browser need, importable by value from a browser half. A module's pure
 * `model.ts` joins it as the modules land, so the rule allows both, and `core/host/client.tsx`
 * is a second structural exception: it is the extension host's browser contract, not a server
 * module, and the page's hosts have to import it by value. That purity is enforced by its own
 * block (`pureBoundary`), over `src/core/domain/**` and a module's `model.ts`: neither may
 * import `node:*`, `bun`/`bun:*` or the Effect runtime; a `model.ts` may import the error
 * taxonomy (`core/platform/effect/errors.ts`) but the domain may not; and `Bun`/`process` are
 * refused as ambient globals. The patterns
 * are matched
 * against the specifier as written, so `serverImports` builds them from the path back to `src/` —
 * `../` for `src/frontend/**`, `../../` for `src/<module>/client/**`, `../../../` for
 * `src/<module>/<submodule>/client/**` — and the client blocks add the sibling `../server/**`
 * (a submodule also adds its parent module's `../../server/**` and its sibling submodules'
 * `../../<submodule>/server/**`) by which a half imports a server. The group restricts every
 * server tree — the top-level `deploySettings.ts`, the built-ins' server halves, all of `core/`
 * (its `platform/`, `integrations/` and `host/`) and every module's `server/` directory —
 * then re-includes `core/domain/`, `core/host/client.tsx` and any module's `model.ts`. Put a new
 * shared vocabulary module in `src/core/domain/`, not next to the server.
 */

/**
 * The server trees a browser half may not import by value, as specifiers relative to it. `up` is
 * the path from the half's directory back to `src/`: `../` from `src/frontend/**`, `../../` from
 * `src/<module>/client/**`, `../../../` from `src/<module>/<submodule>/client/**`. `extra`
 * carries patterns that only make sense at one depth — a client half's own server directory is
 * the sibling `../server/**`, a submodule also spells its parent module's `../../server/**` and
 * its sibling submodules' `../../<submodule>/server/**`, while `src/frontend` has none. The
 * negations re-admit the pure domain, the host's client contract and a module's
 * `model.ts`, and follow the patterns they narrow, which is the order `no-restricted-imports`
 * applies them in.
 */
const serverImports = (up, extra = []) => [
  // `server.ts` is the composition root a half never imports; after S6 the only top-level
  // server module left to name is `deploySettings.ts`. Everything else that shells out lives
  // under `core/` (a module's server half included), which the `core/**` group already covers.
  `${up}deploySettings.ts`,
  ...extra,
  `${up}*/server/**`,
  `${up}core/**`,
  `!${up}core/domain`,
  `!${up}core/domain/**`,
  // The extension host's client contract is browser code that lives under core/ by design:
  // the host owns it, not a module, so a browser half may import this one file by value. Its
  // parent directory is re-included first (a file cannot be re-admitted while every parent is
  // excluded), then its contents are restricted again and the one file re-admitted.
  `!${up}core/host`,
  `${up}core/host/**`,
  `!${up}core/host/client.tsx`,
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
          "a browser half (src/frontend/**, src/<module>/client/** or a submodule's client/) " +
          "may only import server " +
          "modules with `import type`, which is erased before the bundle sees it. The pure " +
          "domain under src/core/domain/ (and a module's model.ts) is importable by value; put " +
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
 * `platform/effect/errors.ts` path segment. */
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
          "A model.ts may import the error taxonomy (core/platform/effect/errors.ts); the domain " +
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
    files: ["src/frontend/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../"),
    },
  },
  {
    files: ["src/*/client/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../../", ["../server/**"]),
    },
  },
  {
    files: ["src/*/*/client/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": browserBoundary("../../../", [
        "../server/**",
        "../../server/**",
        "../../*/server/**",
      ]),
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
    files: ["src/core/host/client.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The host's browser contract is browser code under core/ by design (see serverImports),
      // and the rule that keeps it one has to cover it too.
      "no-restricted-imports": browserBoundary("../../"),
    },
  },
  {
    files: ["src/core/domain/**/*.{ts,tsx}"],
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
