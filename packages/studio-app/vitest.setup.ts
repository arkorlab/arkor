import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Component suites opt into jsdom with `// @vitest-environment jsdom`
// at the top of each `*.test.tsx`. Logic suites stay on the default
// node environment, where `document` is undefined; guard the meta tag
// injection and RTL cleanup so this setup file is safe in either world.
if (typeof document !== "undefined") {
  // `api.ts` reads the CSRF token from `<meta name="arkor-studio-token">`
  // once at module load (see `STUDIO_TOKEN` there). Vitest evaluates
  // setupFiles before any test source, so injecting the meta tag here
  // makes the token available to every test that reaches `apiFetch`.
  const meta = document.createElement("meta");
  meta.name = "arkor-studio-token";
  meta.content = "test-token";
  document.head.appendChild(meta);

  // Pull in @testing-library/react lazily so node-only suites don't
  // import jsdom-only globals through the dependency tree.
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => {
    cleanup();
  });
}
