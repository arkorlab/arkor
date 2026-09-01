import { defineConfig } from "oxfmt";

// See AGENTS.md "oxfmt owns formatting" for the rationale behind the
// disabled `sortPackageJson` / `sortImports` and the ignorePatterns scope.
export default defineConfig({
  printWidth: 80,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  sortPackageJson: false,
  sortImports: false,
  sortTailwindcss: {
    functions: ["cn"],
  },
  ignorePatterns: [
    // Target selection only. What keeps `pnpm format` from descending
    // into `.claude/worktrees/` is the `.claude/` line in `.gitignore`:
    // oxfmt's nested-config discovery respects the ignore file but not
    // these patterns (see AGENTS.md "oxfmt owns formatting").
    ".claude/**",
    "**/*.md",
    "**/*.mdx",
    "**/*.yaml",
    "**/*.yml",
  ],
});
