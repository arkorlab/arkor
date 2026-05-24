import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig } from "eslint/config";
import { flatConfigs as importXConfigs } from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import nodePlugin from "eslint-plugin-n";
import promise from "eslint-plugin-promise";
import reactHooks from "eslint-plugin-react-hooks";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const JS_FILES = ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];
const TEST_FILES = [
  "**/*.test.{ts,tsx,js,jsx,mjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs}",
];
const CONFIG_TS_FILES = [
  "**/tsdown.config.ts",
  "**/vite.config.ts",
  "**/vitest.config.ts",
  "**/vitest.setup.ts",
  "**/playwright.config.ts",
];

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/.arkor/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "packages/arkor/docs/**",
      "packages/*/CONTRIBUTING.md",
      "**/*.md",
      "**/*.mdx",
    ],
  },

  // Baseline JS + TypeScript strict + stylistic (type-aware).
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // Cross-cutting plugins (flat configs).
  unicorn.configs.recommended,
  importXConfigs.recommended,
  importXConfigs.typescript,
  // @ts-expect-error: @types/eslint-plugin-promise@7.3.0 still types
  // `languageOptions` against @types/eslint@9, which has a wider index
  // signature than @eslint/core's `LanguageOptions` (ESLint 10). Runtime
  // shape is correct; remove once upstream republishes against ESLint 10.
  promise.configs["flat/recommended"],
  // `n` ships both legacy and flat configs; only the `flat/` variants are
  // flat-config shaped (the unprefixed name still returns a legacy
  // `extends: string` object).
  nodePlugin.configs["flat/recommended-module"],

  // Project-wide overrides of `unicorn.configs.recommended` defaults.
  // Apply to all files (no `files:` filter) so they affect both TS and JS.
  {
    rules: {
      // Renames `req`/`res`/`params`/`err`/`fn` etc.; would rewrite SDK
      // public parameter names. Not worth the churn or the API-surface
      // risk.
      "unicorn/prevent-abbreviations": "off",
      // `null` and `undefined` are not interchangeable here: JSON-serialised
      // cloud-api payloads and `JSON.stringify` treat them differently.
      "unicorn/no-null": "off",
      // TODO: re-enable. The plan is to turn this back on and then add
      // inline disables only where the negated condition is a deliberate
      // early-return pattern. Audit existing early-returns before flipping
      // back on so the inline disables can land in the same pass.
      "unicorn/no-negated-condition": "off",
      // `window` / `self` carry stricter DOM-typed signatures than
      // `globalThis` in the Studio SPA; not worth the churn.
      "unicorn/prefer-global-this": "off",
      // TODO: revisit. Possibly re-enable once the codebase agrees on a
      // single binding name (`error` vs `err`).
      "unicorn/catch-error-name": "off",
      // Prefer explicit `return undefined;` for clarity.
      "unicorn/no-useless-undefined": "off",
      // unicorn's default is kebab-case only; allow PascalCase too so
      // React component files (`Component.tsx`) pass.
      "unicorn/filename-case": [
        "error",
        { cases: { kebabCase: true, pascalCase: true } },
      ],
    },
  },

  // Type-aware parser options for all TS files. `projectService` lets
  // typescript-eslint discover the nearest tsconfig per file; the
  // `allowDefaultProject` glob covers loose config files that aren't
  // included in any package tsconfig.
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.ts",
            "*.config.ts",
            "*.config.mjs",
            "*.config.js",
          ],
        },
        // @ts-expect-error: `import.meta.dirname` is a Node augmentation of
        // `ImportMeta` declared in `@types/node`, which is not a root
        // devDependency (each package declares it individually). The value
        // is correct at runtime on Node 22.16+; add `@types/node` at the
        // root once we need other Node-typed APIs here, then drop this.
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      // TODO (alpha period): re-enable. Auto-fix removes `async` from
      // functions that never `await`, which changes their return type from
      // `Promise<T>` to `T`. That is a breaking change for any SDK
      // consumer typing against the public surface. Land as part of the alpha-period
      // breaking-change pass, not now.
      "@typescript-eslint/require-await": "off",
      // Off because its auto-fix is unsafe in this codebase. Observed
      // breakages during the initial `--fix` sweep:
      //   1. `typeof __SDK_VERSION__ !== "undefined"` (build-time-define
      //      guard in `core/version.ts` / `core/telemetry.ts`) rewritten
      //      to `__SDK_VERSION__ !== undefined`, throwing `ReferenceError`
      //      under vitest where tsdown's `define` transform never runs.
      //   2. `(await screen.findByRole(...)) as HTMLSelectElement`
      //      narrowings stripped, leaving the value typed as `HTMLElement`
      //      with no `.value` property.
      //   3. `value: null as unknown` widenings stripped, locking the
      //      property type to `null` and breaking later mutating
      //      assignments.
      //   4. Vitest mock helper narrowings (`as typeof fetch`,
      //      `as typeof process.stdout.write`, `as never` on clack
      //      mocks) stripped, since the rule's type-aware check
      //      misreads vitest's polymorphic return types.
      // Revisit once typescript-eslint ships a safer fix mode, or treat
      // genuine redundant assertions as a manual-review item.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "import-x/no-cycle": "error",
      // TS source uses bundler-style extensionless imports (tsconfig
      // `moduleResolution: "bundler"` + tsdown bundling). `import-x`'s
      // typescript resolver handles these; the Node-perspective check from
      // `n` only sees raw specifiers and false-positives.
      "n/no-missing-import": "off",
      "import-x/order": [
        "error",
        {
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
            "object",
            "type",
          ],
        },
      ],
    },
  },

  // Plain JS / mjs files: turn off type-aware rules and use Node script env.
  {
    files: JS_FILES,
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node, ...globals.es2024 },
    },
  },

  // Studio SPA (React, browser). `eslint-plugin-react` does not yet support
  // ESLint 10 (it still calls the removed `context.getFilename()` API), so
  // we run react-hooks + jsx-a11y only. JSX-specific structural rules
  // (jsx-key, jsx-no-duplicate-props, etc.) are covered by oxlint's `react`
  // plugin already.
  {
    files: ["packages/studio-app/**/*.{ts,tsx,jsx}"],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.strict],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // SPA isn't a Node script, so disable node-targeted rules here.
      "n/no-unsupported-features/node-builtins": "off",
    },
  },

  // Vitest tests.
  {
    files: TEST_FILES,
    plugins: { vitest },
    languageOptions: {
      globals: { ...vitest.environments.env.globals },
    },
    rules: {
      ...vitest.configs.recommended.rules,
      // Test stubs and mock callbacks routinely use empty function bodies.
      "@typescript-eslint/no-empty-function": "off",
    },
  },

  // Playwright fixtures use `({}, use) => ...` empty-destructure signature.
  {
    files: ["e2e/studio/**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      "no-empty-pattern": "off",
    },
  },

  // Config files (tsdown/vite/vitest/playwright .ts, eslint.config.ts):
  // type-aware off, since they aren't part of any package's narrow build
  // tsconfig include.
  {
    files: [...CONFIG_TS_FILES, "eslint.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },

  // eslint.config.ts itself:
  //   - typescript-eslint and import-x intentionally expose `configs` /
  //     `flatConfigs` as both default and named exports, so the documented
  //     `tseslint.configs.X` / `importXConfigs.X` pattern trips
  //     `import-x/no-named-as-default-member`.
  //   - `import.meta.dirname` is only evaluated when ESLint loads this
  //     file. The `n` plugin reads the nearest `package.json#engines.node`
  //     to validate Node API usage and the root is intentionally left
  //     without `engines.node` (private workspace, not published, no need
  //     to leak ESLint-only constraints onto local dev). Disable the
  //     resulting `n/no-unsupported-features/node-builtins` here only.
  {
    files: ["eslint.config.ts"],
    rules: {
      "import-x/no-named-as-default-member": "off",
      "n/no-unsupported-features/node-builtins": "off",
    },
  },

  // Build / one-shot Node scripts: relax rules that don't fit short CLIs.
  {
    files: ["**/scripts/**/*.{mjs,js,ts}"],
    rules: {
      "n/hashbang": "off",
      "unicorn/no-process-exit": "off",
    },
  },
);
