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
    ".claude/**",
    "**/*.md",
    "**/*.mdx",
    "**/*.yaml",
    "**/*.yml",
  ],
});
