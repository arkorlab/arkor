import { describe, expect, it } from "vitest";
import { buildQuickStartSample } from "./QuickStart";

// `buildQuickStartSample` powers the QuickStart card on the Endpoint
// detail page. The function itself is a plain string-templating helper
// — it doesn't render anything or call into React — so unit testing it
// directly covers the language / authMode / URL-shaping permutations
// without standing up the SPA. (The module it lives in does import
// React for the `<QuickStart>` component sibling, so this test pulls
// React in transitively; that's fine because we never invoke any hook
// or component code from these tests.)
//
// Naming note: the constant below would normally just be `URL`, but that
// shadows the global `URL` constructor (which `QuickStart.tsx` itself
// uses for SDK base-URL derivation), so `ENDPOINT_URL` keeps the
// intent clear and avoids future-refactor surprises.
const ENDPOINT_URL = "https://mymodel.arkor.app/v1/chat/completions";

describe("buildQuickStartSample — cURL", () => {
  it("includes the Authorization header when authMode is fixed_api_key", () => {
    const out = buildQuickStartSample({
      language: "curl",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "fixed_api_key",
    });
    expect(out).toContain(`curl -X POST ${ENDPOINT_URL}`);
    expect(out).toContain("Authorization: Bearer YOUR_API_KEY");
    expect(out).toContain("Content-Type: application/json");
    expect(out).toContain('"model":"ignored"');
  });

  it("omits the Authorization header when authMode is none (per the task spec)", () => {
    // The Runpod-style Quick Start renders the api-key line only when
    // the endpoint actually enforces it. For an open deployment the
    // sample MUST NOT carry a placeholder header, otherwise copy-paste
    // users would think auth is mandatory.
    const out = buildQuickStartSample({
      language: "curl",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "none",
    });
    expect(out).not.toContain("Authorization");
    expect(out).not.toContain("YOUR_API_KEY");
    expect(out).toContain("Content-Type: application/json");
  });
});

describe("buildQuickStartSample — Python (openai SDK)", () => {
  it("strips the chat-completions path so the SDK can route", () => {
    // The OpenAI SDK appends `/chat/completions` itself; if we left the
    // suffix on `base_url`, the SDK would POST to `/v1/chat/completions
    // /chat/completions` and 404. Sample output must point at `/v1`.
    const out = buildQuickStartSample({
      language: "python",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "fixed_api_key",
    });
    expect(out).toContain('base_url="https://mymodel.arkor.app/v1"');
    expect(out).not.toContain("/v1/chat/completions");
    expect(out).toContain('api_key="YOUR_API_KEY"');
    expect(out).toContain('client.chat.completions.create');
  });

  it("uses a `not-required` placeholder + comment when authMode is none", () => {
    // OpenAI's Python SDK refuses to construct a client without a
    // non-empty `api_key`, even when the upstream doesn't enforce one.
    // The sample uses a placeholder and a comment so a copy-paste user
    // doesn't think they need to mint a real key.
    const out = buildQuickStartSample({
      language: "python",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "none",
    });
    expect(out).toContain('api_key="not-required"');
    expect(out).toContain("auth_mode=none on this deployment");
    expect(out).not.toContain("YOUR_API_KEY");
  });
});

describe("buildQuickStartSample — JavaScript (openai SDK)", () => {
  it("strips the chat-completions path and includes apiKey when required", () => {
    const out = buildQuickStartSample({
      language: "javascript",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "fixed_api_key",
    });
    expect(out).toContain('baseURL: "https://mymodel.arkor.app/v1"');
    expect(out).not.toContain("/v1/chat/completions");
    expect(out).toContain('apiKey: "YOUR_API_KEY"');
    expect(out).toContain("client.chat.completions.create");
  });

  it("uses the `not-required` placeholder when authMode is none", () => {
    const out = buildQuickStartSample({
      language: "javascript",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "none",
    });
    expect(out).toContain('apiKey: "not-required"');
    expect(out).not.toContain("YOUR_API_KEY");
  });

  it("flags the ESM requirement up front so a copy-paste user sees it before running", () => {
    // The `import OpenAI from "openai"` line is ESM-only; pasting it
    // into a default CommonJS `.js` script (the Node default without
    // `"type": "module"`) is a `SyntaxError` before any request runs.
    // The leading `// Requires ESM` comment travels with the snippet
    // so the constraint is visible to anyone who only reads what they
    // pasted.
    const out = buildQuickStartSample({
      language: "javascript",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "fixed_api_key",
    });
    // The marker must come *before* the `import` so the reader sees
    // the requirement before the line that fails to parse under CJS.
    const markerIdx = out.indexOf("Requires ESM");
    const importIdx = out.indexOf('import OpenAI from "openai"');
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(markerIdx);
  });

  it("wraps `await` in an async function instead of using top-level await", () => {
    // TLA is a hard `SyntaxError` in CommonJS scripts and in any non-
    // module-aware paste target (REPL, scratch file without
    // `"type": "module"`, etc.). The sample is meant to be ready to
    // copy into the dominant Node setup, so the await needs a
    // function wrapper that runs in both module systems.
    const out = buildQuickStartSample({
      language: "javascript",
      operation: "chat",
      endpointUrl: ENDPOINT_URL,
      authMode: "fixed_api_key",
    });
    expect(out).toContain("async function main()");
    expect(out).toContain("main();");
    // Defensive: catch a future regression that re-introduces TLA.
    // The only `await` in the sample MUST live inside `async function
    // main()` — i.e. it must come *after* the wrapper line.
    const wrapperIdx = out.indexOf("async function main()");
    const awaitIdx = out.indexOf("await ");
    expect(wrapperIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(wrapperIdx);
  });
});

describe("buildQuickStartSample — base URL derivation", () => {
  // The SDK languages (Python/JS) need `/v1`, not the full per-operation
  // URL — the OpenAI SDK appends its own path. Derive that from `URL`
  // parsing rather than a hard-coded suffix-strip so a future operation
  // landing on a different path (e.g. `/v1/embeddings`) doesn't silently
  // ship a 404-ing sample.
  it("yields `/v1` even if the input URL doesn't end in /v1/chat/completions", () => {
    const out = buildQuickStartSample({
      language: "python",
      operation: "chat",
      // Imagine a future deployment shape where the dropdown also picks
      // operation, and the operation's endpoint URL is e.g.
      // `/v1/embeddings`. The base-URL derivation must still produce
      // `/v1` — not leave the operation suffix in place.
      endpointUrl: "https://mymodel.arkor.app/v1/embeddings",
      authMode: "fixed_api_key",
    });
    expect(out).toContain('base_url="https://mymodel.arkor.app/v1"');
    expect(out).not.toContain("/embeddings");
  });

  it("preserves the host when the input has a non-default port", () => {
    // Defensive: `URL.toString()` re-emits the explicit port. The base
    // URL must keep it so a dev pointing Studio at a tunnelled host
    // (e.g. `host.tld:8443`) still gets a runnable sample.
    const out = buildQuickStartSample({
      language: "javascript",
      operation: "chat",
      endpointUrl: "https://mymodel.arkor.app:8443/v1/chat/completions",
      authMode: "fixed_api_key",
    });
    expect(out).toContain('baseURL: "https://mymodel.arkor.app:8443/v1"');
  });

  it("falls back to suffix-strip when the input URL is malformed", () => {
    // Defence-in-depth: if `endpointUrl` somehow isn't parseable by the
    // browser's URL constructor, the function must not throw and crash
    // the SPA — it should return a usable string built from the
    // previous suffix-strip approach.
    const out = buildQuickStartSample({
      language: "python",
      operation: "chat",
      endpointUrl: "not-a-valid-url/v1/chat/completions",
      authMode: "fixed_api_key",
    });
    expect(out).toContain('base_url="not-a-valid-url/v1"');
  });
});
