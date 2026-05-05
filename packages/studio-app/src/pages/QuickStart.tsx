import { useState, type ReactNode } from "react";
import { type DeploymentAuthMode } from "../lib/api";
import { Button } from "../components/ui/Button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { CopyButton } from "../components/ui/CopyButton";
import { BookOpen, ExternalLink, Sparkles } from "../components/icons";

// ---------------------------------------------------------------------------
// Quick start: language- and operation-keyed code samples.
// ---------------------------------------------------------------------------
//
// Renders a Runpod-style "click to copy a curl" block on the endpoint
// detail page. Lives in its own module so the detail page stays focused
// on deployment CRUD, and so `buildQuickStartSample` is unit-testable
// without rendering React.

export type SampleLanguage = "curl" | "python" | "javascript";
export type SampleOperation = "chat";

const SAMPLE_LANGUAGES: { value: SampleLanguage; label: string }[] = [
  { value: "curl", label: "cURL" },
  { value: "python", label: "Python (OpenAI SDK)" },
  { value: "javascript", label: "JavaScript (OpenAI SDK)" },
];

// `description` is a `ReactNode` rather than a plain string so we can
// render real `<code>` elements inline. The earlier shape used
// Markdown-style backticks in the string and rendered with
// `{opMeta.description}`, which surfaced literal backticks in the UI.
const SAMPLE_OPERATIONS: {
  value: SampleOperation;
  label: string;
  description: ReactNode;
}[] = [
  {
    value: "chat",
    label: "POST /v1/chat/completions",
    description: (
      <>
        Send a chat completion request. The body uses the OpenAI Chat
        Completions schema;{" "}
        <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-900">
          model
        </code>{" "}
        is ignored because the deployment pins the target adapter or
        base model.
      </>
    ),
  },
];

const SAMPLE_PROMPT = "Hello!";

/**
 * Strip the operation segment off `endpointUrl` so the OpenAI SDK can
 * append its own routing. Hand the SDK `https://…/v1`, not the full
 * per-operation URL — otherwise the SDK appends `/chat/completions`
 * itself and we'd POST to `/v1/chat/completions/chat/completions`.
 *
 * Use `URL` parsing (not a hard-coded suffix-strip) so a future
 * operation landing on a different path (e.g. `/v1/embeddings`) doesn't
 * silently no-op the strip and ship a 404-ing sample.
 */
function deriveSdkBaseUrl(endpointUrl: string): string {
  try {
    const parsed = new URL(endpointUrl);
    parsed.pathname = "/v1";
    parsed.search = "";
    parsed.hash = "";
    // Setting `pathname` to a non-empty value ("/v1") makes
    // `toString()` emit `https://host/v1` with no trailing slash —
    // exactly the shape the OpenAI SDK expects, so no extra
    // normalisation is needed here.
    return parsed.toString();
  } catch {
    // Defensive: if `endpointUrl` is malformed for any reason, fall
    // back to a simple suffix-strip rather than crashing the SPA.
    return endpointUrl.replace(/\/v1\/chat\/completions$/, "/v1");
  }
}

export function buildQuickStartSample(opts: {
  language: SampleLanguage;
  operation: SampleOperation;
  endpointUrl: string;
  authMode: DeploymentAuthMode;
}): string {
  const { language, endpointUrl, authMode } = opts;
  // The dropdown only carries `chat` today, but the operation arg is
  // kept so adding `embeddings` / `completions` later is just a new
  // entry in `SAMPLE_OPERATIONS` and a new branch here.
  const requiresAuth = authMode === "fixed_api_key";
  if (language === "curl") {
    // The cURL branch hits the per-operation URL directly; SDK base
    // URL derivation is *not* needed here, so don't pay for the URL
    // parse on every keystroke just to throw the result away.
    //
    // Quoting style matches `docs/studio/endpoints.mdx`: `-H` uses
    // double quotes (so a user can drop a shell variable like
    // `$ARK_KEY` in for the bearer token without re-quoting), and `-d`
    // uses single quotes so the JSON body's double-quoted keys don't
    // need shell-escaping.
    const lines = [
      `curl -X POST ${endpointUrl} \\`,
      `  -H "Content-Type: application/json" \\`,
    ];
    if (requiresAuth) {
      lines.push(`  -H "Authorization: Bearer YOUR_API_KEY" \\`);
    }
    lines.push(
      `  -d '{"model":"ignored","messages":[{"role":"user","content":"${SAMPLE_PROMPT}"}]}'`,
    );
    return lines.join("\n");
  }
  // Both SDK languages need the bare `/v1` base URL — derive it once
  // for either branch. (Same sample for both Python and JS today, but
  // each branch may diverge with new operations / SDK options.)
  const baseUrl = deriveSdkBaseUrl(endpointUrl);
  if (language === "python") {
    const apiKeyLine = requiresAuth
      ? `    api_key="YOUR_API_KEY",`
      : `    # auth_mode=none on this deployment; the OpenAI SDK still\n    # requires a non-empty value but the server ignores it.\n    api_key="not-required",`;
    return [
      `from openai import OpenAI`,
      ``,
      `client = OpenAI(`,
      `    base_url="${baseUrl}",`,
      apiKeyLine,
      `)`,
      ``,
      `response = client.chat.completions.create(`,
      `    model="ignored",`,
      `    messages=[{"role": "user", "content": "${SAMPLE_PROMPT}"}],`,
      `)`,
      `print(response.choices[0].message.content)`,
    ].join("\n");
  }
  // javascript
  // The `openai` package itself ships ESM (`import OpenAI from
  // "openai"`); a CommonJS-style `require("openai")` paste-target
  // would have to use the dynamic-import workaround, which is more
  // friction than just enabling ESM. Document the requirement at the
  // top of the snippet itself so the constraint travels with the
  // copy-paste, and wrap the `await` in `async function main()` so
  // the snippet still parses in older Node ESM versions before
  // top-level await landed (Node < 14.8) and in environments that
  // disable TLA (some bundler configs).
  const apiKeyLine = requiresAuth
    ? `  apiKey: "YOUR_API_KEY",`
    : `  // auth_mode=none on this deployment; the OpenAI SDK still\n  // requires a non-empty value but the server ignores it.\n  apiKey: "not-required",`;
  return [
    `// Requires ESM — save as .mjs, or set "type": "module" in package.json.`,
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({`,
    `  baseURL: "${baseUrl}",`,
    apiKeyLine,
    `});`,
    ``,
    `async function main() {`,
    `  const response = await client.chat.completions.create({`,
    `    model: "ignored",`,
    `    messages: [{ role: "user", content: "${SAMPLE_PROMPT}" }],`,
    `  });`,
    `  console.log(response.choices[0].message.content);`,
    `}`,
    ``,
    `main();`,
  ].join("\n");
}

export function QuickStart({
  endpointUrl,
  authMode,
}: {
  endpointUrl: string;
  authMode: DeploymentAuthMode;
}) {
  const [language, setLanguage] = useState<SampleLanguage>("curl");
  const [operation, setOperation] = useState<SampleOperation>("chat");
  const [hidden, setHidden] = useState(false);

  const sample = buildQuickStartSample({
    language,
    operation,
    endpointUrl,
    authMode,
  });
  const opMeta = SAMPLE_OPERATIONS.find((o) => o.value === operation);

  return (
    <Card>
      <CardHeader
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setHidden((v) => !v)}
            aria-expanded={!hidden}
          >
            {hidden ? "Show" : "Hide"}
          </Button>
        }
      >
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500 dark:text-amber-400" />
          <CardTitle>Quick start</CardTitle>
        </div>
        <CardDescription>
          See examples of how to call this endpoint from your code.
        </CardDescription>
      </CardHeader>
      {!hidden && (
        <CardContent className="space-y-4">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            This deployment speaks the OpenAI Chat Completions wire
            format. cURL hits the URL above directly; OpenAI-compatible
            SDKs take the base URL ending in
            <code className="mx-1 rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-900">
              /v1
            </code>
            (the samples below cover both shapes — pointing an SDK at
            the full
            <code className="mx-1 rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-900">
              /v1/chat/completions
            </code>
            URL would have it append its own route and 404). Add
            <code className="mx-1 rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-900">
              {`"stream": true`}
            </code>
            to the request body, or set
            <code className="mx-1 rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-900">
              stream: true
            </code>
            on the SDK call, to receive SSE token-by-token responses;
            the samples below are non-streaming by default.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span className="sr-only">Language</span>
              <select
                value={language}
                onChange={(e) =>
                  setLanguage(e.target.value as SampleLanguage)
                }
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                aria-label="Sample language"
              >
                {SAMPLE_LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span className="sr-only">Operation</span>
              <select
                value={operation}
                onChange={(e) =>
                  setOperation(e.target.value as SampleOperation)
                }
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                aria-label="Operation"
              >
                {SAMPLE_OPERATIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {opMeta && (
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              {opMeta.description}
            </p>
          )}

          <a
            href="https://docs.arkor.ai/studio/endpoints"
            target="_blank"
            // `noopener` defends against tabnabbing — without it, the
            // opened docs page could read `window.opener` and navigate
            // the Studio tab somewhere malicious. `noreferrer` is kept
            // for `Referer`-header privacy. Modern browsers imply
            // `noopener` for `target="_blank"`, but spelling it
            // explicitly stays correct under older user agents and
            // sidesteps the lint rule entirely.
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-teal-600 hover:underline dark:text-teal-400"
          >
            <BookOpen className="h-4 w-4" />
            Endpoints documentation
            <ExternalLink className="h-3.5 w-3.5" />
          </a>

          <div className="relative rounded-lg bg-zinc-50 dark:bg-zinc-900">
            <pre className="overflow-x-auto px-3 py-3 pr-12 font-mono text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
              <code>{sample}</code>
            </pre>
            <div className="absolute right-2 top-2">
              <CopyButton value={sample} />
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
