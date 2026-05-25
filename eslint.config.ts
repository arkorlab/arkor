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

  // Pin `n`'s view of the target Node.js to a single concrete version
  // (the lowest we support at runtime) instead of letting it read each
  // package's `engines.node` range. The plugin's `no-unsupported-*`
  // rules check the *entire* configured range; an unbounded `>=22.22.0`
  // would include early 23.x releases where APIs like `ReadableStream`
  // (backport range `^22.15`) aren't yet stable, producing false
  // positives. Pinning to "22.22.0" tells the plugin to test against
  // that one version (which IS in every relevant backport range) —
  // future Node API adoption still gets flagged correctly because the
  // minimum-version check is the part we actually care about.
  {
    settings: {
      n: {
        version: "22.22.0",
      },
    },
  },

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
      // Forces `{}` around every `case` body, so `case "x": return foo;`
      // must become `case "x": { return foo; }`. Off so concise
      // expression-style cases stay legal; braces only when actually
      // needed (declarations etc.).
      "unicorn/switch-case-braces": "off",
      // unicorn's default is kebab-case only. Allow PascalCase for
      // React components (`Component.tsx`).
      //
      // TODO: drop `camelCase` once the inconsistent files are renamed
      // to kebab-case. Currently kept on so 7 holdouts compile:
      //   - packages/arkor/src/core/projectState{,.test}.ts
      //                                  -> project-state{,.test}.ts
      //   - packages/studio-app/src/lib/baseModels{,.test}.ts
      //                                  -> base-models{,.test}.ts
      //   - e2e/studio/src/harness/{cloudApiMock,seedFixture,studioServer}.ts
      //                                  -> kebab-case equivalents
      // Each rename also needs an import-reference sweep, which is why
      // it's staged separately from the lint integration.
      "unicorn/filename-case": [
        "error",
        { cases: { kebabCase: true, camelCase: true, pascalCase: true } },
      ],
      // unicorn's default insists on `import path from "node:path"` (the
      // `path.join` / `path.dirname` form). The repo has unanimously
      // chosen named imports (40+ sites, 0 default) so the call sites
      // read `join()` / `dirname()` directly. Carve out `node:path`
      // here; keep the rest of the rule's per-module preferences
      // (react named, react-dom named, etc.).
      "unicorn/import-style": [
        "error",
        {
          extendDefaultStyles: true,
          styles: {
            "node:path": { named: true },
          },
        },
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
      //   1. `(await screen.findByRole(...)) as HTMLSelectElement`
      //      narrowings stripped, leaving the value typed as `HTMLElement`
      //      with no `.value` property.
      //   2. `value: null as unknown` widenings stripped, locking the
      //      property type to `null` and breaking later mutating
      //      assignments.
      //   3. Vitest mock helper narrowings (`as typeof fetch`,
      //      `as typeof process.stdout.write`, `as never` on clack
      //      mocks) stripped, since the rule's type-aware check
      //      misreads vitest's polymorphic return types.
      // Revisit once typescript-eslint ships a safer fix mode, or treat
      // genuine redundant assertions as a manual-review item.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // `while (true)` is the idiomatic infinite-loop spelling for SSE
      // readers and retry loops; the rule would otherwise force `for (;;)`
      // or constant-literal contortions.
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        { allowConstantLoopConditions: true },
      ],
      // Don't require a `return` from the *last* `.then` in a chain.
      // The rule's intent is to catch `.then(() => doSideEffect())`
      // that silently drops the return value before more `.then`s
      // downstream; the terminal callback (typically followed only by
      // `.catch`) has no consumer that needs a value. Without this
      // option, every `fetchX().then(setState).catch(setError)` would
      // need a noisy `return undefined;`.
      "promise/always-return": ["error", { ignoreLastCallback: true }],
      // Honor the universal `_`-prefix convention for "intentionally
      // unused" parameters and bindings (callbacks that ignore the
      // first arg, destructured tuples where only some are used, etc.).
      // typescript-eslint's strict preset doesn't ship this by default.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Skip `||` on boolean primitives. `disabled || isEmpty` reads as
      // "either of these is true" — semantically *boolean OR*. Rewriting
      // to `??` would change behaviour (`false ?? true === false`), so
      // the rule's suggestion would actively break the logic. Keep the
      // rule on for nullable non-booleans where `??` really is safer.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { boolean: true } },
      ],
      // TODO: revisit. `stylisticTypeChecked` defaults this to "interface",
      // which would auto-rewrite every `type X = { ... }` in the codebase.
      // Both forms are legitimate (interfaces merge, type aliases compose
      // with unions/intersections), so leave the choice to the author for
      // now and decide a project-wide preference in a separate pass.
      "@typescript-eslint/consistent-type-definitions": "off",
      // Off because it fires on the very common event-handler pattern
      // `onClick={() => trackEvent()}` (the inner call returns `void`, so
      // the concise arrow "confusingly" returns void). Wrapping every
      // such handler in braces (`() => { trackEvent(); }`) is pure noise
      // for the reader.
      "@typescript-eslint/no-confusing-void-expression": "off",
      // `strict-type-checked` flips every `allow*` off, but `number` is
      // safe to interpolate (toString is unambiguous) and pervasive in
      // SVG attribute strings, React `key`s, URLs, log lines, etc.
      // Keep the rest of the rule's defaults — `null` / `undefined` /
      // `object` / `RegExp` interpolation stays an error.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
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
      // The 3-way render ladder `loading ? <Spinner /> : empty ? <Empty
      // /> : <List />` is the React idiom for multi-state UI; extracting
      // each variant to a named helper just to satisfy the rule scatters
      // the render around. Lookup-table / early-return refactors only
      // win in non-JSX code.
      "unicorn/no-nested-ternary": "off",
      // TODO: revisit during the React 19 refactor pass. The rule
      // flags every `setState` inside `useEffect`, including patterns
      // React itself acknowledges as valid:
      //   - initial sync from external state on mount
      //     (ThemeToggle reading localStorage)
      //   - resetting derived state when a key prop changes
      //     (Endpoints / JobDetail page-level effects)
      //   - syncing an `initial*` prop into local state when the prop
      //     changes (Playground adapter)
      // The rule's preferred alternatives (`useSyncExternalStore`,
      // `key`-based remount, lifting to parent) are real refactors per
      // site. Keep the rule off here until that pass; the React 19
      // upgrade is the right moment to revisit them all together.
      "react-hooks/set-state-in-effect": "off",
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
      // Teach the rule about codebase-local aliases of `it` so calls
      // like `onPosix("...", () => { expect(...) })` aren't mistaken for
      // standalone `expect()` outside a test body. Add new aliases here
      // as they appear.
      "vitest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["onPosix"] },
      ],
      // Test stubs and mock callbacks routinely use empty function bodies.
      "@typescript-eslint/no-empty-function": "off",
      // Tests set up the data they assert on, so `!` after `find()` /
      // `match()` / array access typically encodes an invariant the test
      // itself just established. Catching genuine "unexpected null" bugs
      // is valuable in production code; in tests it's noise.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Mock fetch implementations universally take `RequestInfo | URL`
      // and tests always invoke them with bare strings, so the rule's
      // theoretical concern (`String(req)` producing "[object Request]")
      // doesn't materialise. Same for assertions that interpolate
      // `Response`-shaped mocks. Keep the rule on for production code,
      // where the concern is real.
      "@typescript-eslint/no-base-to-string": "off",
      // The `no-unsafe-*` family fires whenever a value is typed `any`,
      // which is endemic in tests: `JSON.parse(stdout)`, spy/mock
      // returns, intercepted call args from `vi.mocked(fn).mock.calls`,
      // etc. all surface as `any`. Asserting the right shape at each
      // probe is real production work but it crushes test readability.
      // Keep on in production where it catches actual untyped paths.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Test files routinely declare helper closures inside `describe` /
      // `it` blocks for narrative locality even when those closures
      // don't capture outer state. The rule would force hoisting them
      // to module scope, scattering setup-adjacent helpers far from
      // the assertions they support.
      "unicorn/consistent-function-scoping": "off",
      // Tests follow the vitest convention `import { vi } from "vitest"`
      // -> `vi.mock(...)` -> import the mocked module so the mock is set
      // up before the SUT pulls it in. That fragments the file into two
      // import blocks separated by `vi.mock` statements, which trips
      // both the "no blank line within a group" and the cross-group
      // alphabetisation checks. The convention is intentional and rule
      // gymnastics (inline disables on every mock) would read worse
      // than just exempting tests.
      "import-x/order": "off",
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
      "n/no-process-exit": "off",
    },
  },

  // CLI entry points and command handlers: `process.exit()` is the
  // standard way to set the shell exit code at the process root, kill
  // the loop in a SIGINT/SIGTERM handler, or bail out of an interactive
  // clack prompt that the user cancelled. The rule's "throw and let the
  // caller handle it" advice doesn't apply when *we are the caller*.
  {
    files: [
      "**/bin.ts",
      "**/bin.mjs",
      "packages/arkor/src/cli/commands/**/*.ts",
    ],
    rules: {
      "n/no-process-exit": "off",
      "unicorn/no-process-exit": "off",
    },
  },
);
