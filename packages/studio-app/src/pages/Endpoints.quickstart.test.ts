import { describe, expect, it } from "vitest";
import { buildQuickStartSample } from "./Endpoints";

// `buildQuickStartSample` powers the QuickStart card on the Endpoint
// detail page. It's pure (no React), so unit testing it directly covers
// the language / authMode / URL-shaping permutations without rendering
// the SPA.

const URL = "https://mymodel.arkor.app/v1/chat/completions";

describe("buildQuickStartSample — cURL", () => {
  it("includes the Authorization header when authMode is fixed_api_key", () => {
    const out = buildQuickStartSample({
      language: "curl",
      operation: "chat",
      endpointUrl: URL,
      authMode: "fixed_api_key",
    });
    expect(out).toContain(`curl -X POST ${URL}`);
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
      endpointUrl: URL,
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
      endpointUrl: URL,
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
      endpointUrl: URL,
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
      endpointUrl: URL,
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
      endpointUrl: URL,
      authMode: "none",
    });
    expect(out).toContain('apiKey: "not-required"');
    expect(out).not.toContain("YOUR_API_KEY");
  });
});
