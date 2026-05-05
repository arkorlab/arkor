import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// `api.ts` reads the CSRF token from `<meta name="arkor-studio-token">` once
// at module load (see `STUDIO_TOKEN` there). Because Vitest evaluates
// setupFiles before any test source — and therefore before `api.ts` is
// imported — injecting the meta tag here makes the token available to
// every test that reaches `apiFetch`.
const meta = document.createElement("meta");
meta.name = "arkor-studio-token";
meta.content = "test-token";
document.head.appendChild(meta);

afterEach(() => {
  cleanup();
});
