import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import", "promise"],
  categories: {
    correctness: "error",
  },
  env: {
    builtin: true,
    node: true,
    es2024: true,
  },
  ignorePatterns: [
    "**/dist/**",
    "**/.arkor/**",
    "**/coverage/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "**/.turbo/**",
    "**/node_modules/**",
    // Local Claude Code worktrees (other branches checked out as siblings
    // via `git worktree`); never our source. Mirrors eslint.config.ts and
    // oxfmt.config.ts so the three tools agree on scope.
    ".claude/**",
    "packages/arkor/docs/**",
    "packages/*/CONTRIBUTING.md",
    "**/*.md",
    "**/*.mdx",
  ],
  rules: {
    eqeqeq: ["error", "always"],
    "typescript/consistent-type-imports": [
      "error",
      { prefer: "type-imports", fixStyle: "inline-type-imports" },
    ],
    "typescript/no-import-type-side-effects": "error",
    "promise/always-return": ["error", { ignoreLastCallback: true }],
    "import/no-cycle": "error",
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      },
    ],
    "unicorn/filename-case": [
      "error",
      { cases: { kebabCase: true, camelCase: true, pascalCase: true } },
    ],
    "unicorn/no-null": "off",
    "unicorn/no-negated-condition": "off",
    "unicorn/prefer-global-this": "off",
    "unicorn/catch-error-name": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/switch-case-braces": "off",
  },
  overrides: [
    {
      files: ["packages/studio-app/**/*.{ts,tsx,jsx}"],
      plugins: [
        "typescript",
        "unicorn",
        "oxc",
        "import",
        "promise",
        "react",
        "jsx-a11y",
      ],
      env: {
        browser: true,
      },
      rules: {
        "react/rules-of-hooks": "error",
        "react/exhaustive-deps": "error",
        "unicorn/no-nested-ternary": "off",
      },
    },
    {
      files: ["**/*.test.{ts,tsx,js,jsx,mjs}", "**/*.spec.{ts,tsx,js,jsx,mjs}"],
      plugins: ["typescript", "unicorn", "oxc", "import", "promise", "vitest"],
      env: {
        node: true,
      },
      rules: {
        "vitest/require-mock-type-parameters": "off",
        "vitest/no-standalone-expect": [
          "error",
          { additionalTestBlockFunctions: ["onPosix", "testFn"] },
        ],
        "vitest/no-conditional-expect": "off",
        "vitest/valid-title": "off",
        "typescript/no-empty-function": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-dynamic-delete": "off",
        "unicorn/consistent-function-scoping": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      files: ["e2e/studio/**/*.{ts,tsx,js,jsx,mjs}"],
      rules: {
        "eslint/no-empty-pattern": "off",
      },
    },
    {
      files: [
        "**/scripts/**/*.{mjs,js,ts}",
        "**/bin.ts",
        "**/bin.mjs",
        "packages/arkor/src/cli/commands/**/*.ts",
        // Mirror eslint.config.ts's no-process-exit glob set exactly
        // (deliberate-parity policy; see AGENTS.md "Two linters").
        // These two modules own signal-driven shutdown and legitimately
        // call process.exit outside the commands/ tree.
        "packages/arkor/src/cli/cleanupHooks.ts",
        "packages/arkor/src/core/runnerSignals.ts",
      ],
      rules: {
        "unicorn/no-process-exit": "off",
      },
    },
  ],
});
