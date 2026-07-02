// Documentation drift check, as a single zero-dependency script.
//
// Reads a unified diff (the code changes of a pull request) and one or more
// documentation files, then asks an Arkor-hosted model over the
// OpenAI-compatible chat-completions API whether those changes make each
// document inaccurate. See README.md in this directory for setup, and for the
// zero-setup alternative: the drift-check GitHub App
// (https://github.com/apps/drift-check).
//
// Usage: node src/check.ts [diff-file] [doc-file...]
// Env:   ARKOR_BASE_URL (required), ARKOR_API_KEY, ARKOR_MODEL

import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "gemma-4-31b-it";

// Keep prompts well under typical context limits; a real product would chunk
// instead of truncating (the drift-check App does).
const MAX_TEXT_CHARS = 48_000;

const SEVERITIES = ["info", "warning", "error"] as const;
type Severity = (typeof SEVERITIES)[number];

interface Verdict {
  drifted: boolean;
  severity: Severity;
  explanation: string;
  suggestion: string;
}

const VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["drifted", "severity", "explanation", "suggestion"],
  properties: {
    drifted: { type: "boolean" },
    severity: { type: "string", enum: [...SEVERITIES] },
    explanation: { type: "string" },
    suggestion: { type: "string" },
  },
} as const;

const SYSTEM_PROMPT = `You review documentation against code changes.
Decide whether the given unified diff makes the given documentation file
inaccurate, misleading, or incomplete.

Set "drifted" to true ONLY for a clear inconsistency introduced by this diff,
for example: the documentation names a flag, command, default value, or file
that the diff renames, removes, or changes. Ignore style and unrelated or
pre-existing issues. When unsure, set "drifted" to false.

severity: "error" when the documentation now contradicts the code,
"warning" when it is likely stale, "info" for minor drift.
explanation: one or two specific sentences naming the doc statement and the
change. suggestion: a concrete documentation fix when drifted, else "".

Respond with ONLY a JSON object matching the provided schema.`;

function usage(): string {
  return [
    "doc-drift: check whether a pull request diff makes documentation stale.",
    "",
    "Usage: node src/check.ts [diff-file] [doc-file...]",
    "       (defaults: samples/changes.diff samples/doc.md)",
    "",
    "Required environment:",
    "  ARKOR_BASE_URL  OpenAI-compatible base URL of your Arkor deployment,",
    "                  e.g. https://your-model.arkor.app/v1",
    "Optional environment:",
    "  ARKOR_API_KEY   API key, when the deployment uses fixed_api_key auth",
    `  ARKOR_MODEL     Model name (default: ${DEFAULT_MODEL})`,
    "",
    "Prefer zero setup? Install the drift-check GitHub App instead:",
    "  https://github.com/apps/drift-check",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

async function readText(path: string, kind: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`Could not read ${kind} file: ${path}`);
  }
}

function isVerdict(value: unknown): value is Verdict {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<Record<keyof Verdict, unknown>>;
  return (
    typeof record.drifted === "boolean" &&
    typeof record.explanation === "string" &&
    typeof record.suggestion === "string" &&
    SEVERITIES.includes(record.severity as Severity)
  );
}

/** Extract choices[0].message.content from an OpenAI-compatible response. */
function extractContent(payload: unknown): string {
  const typed = (payload ?? {}) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = typed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Model returned an empty response");
  }
  return content;
}

async function requestVerdict(
  config: { baseUrl: string; apiKey: string; model: string },
  docText: string,
  diffText: string,
): Promise<Verdict> {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "doc_drift",
          strict: true,
          schema: VERDICT_JSON_SCHEMA,
        },
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            "=== DOCUMENTATION ===",
            truncate(docText, MAX_TEXT_CHARS),
            "",
            "=== CODE CHANGES (unified diff) ===",
            truncate(diffText, MAX_TEXT_CHARS),
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = truncate(await response.text(), 300);
    throw new Error(`Request failed: HTTP ${String(response.status)} ${body}`);
  }

  const verdict: unknown = JSON.parse(extractContent(await response.json()));
  if (!isVerdict(verdict)) {
    throw new Error("Model response did not match the verdict schema");
  }
  return verdict;
}

/** Resolve a path relative to this example directory. */
function here(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

/**
 * Make a model- or user-controlled string safe inside one Markdown table cell:
 * bounded length, no newlines (they would end the row), no pipes (they would
 * split the cell), no backticks (they could break the inline-code span).
 */
function tableCell(text: string): string {
  return truncate(text, 500)
    .replaceAll(/\r?\n/g, " ")
    .replaceAll("|", String.raw`\|`)
    .replaceAll("`", "'");
}

/** Append a Markdown result table to the GitHub Actions job summary, if any. */
async function writeStepSummary(
  results: { path: string; verdict: Verdict }[],
): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const rows = results.map(
    ({ path, verdict }) =>
      `| \`${tableCell(path)}\` | ${verdict.drifted ? "drifted" : "ok"} | ${
        verdict.severity
      } | ${verdict.drifted ? tableCell(verdict.explanation) : ""} |`,
  );
  const table = [
    "## Documentation drift check",
    "",
    "| Document | Result | Severity | Explanation |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  await appendFile(summaryPath, table);
}

async function main(): Promise<void> {
  const baseUrl = process.env.ARKOR_BASE_URL;
  if (!baseUrl) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  // Treat empty env values as unset: in GitHub Actions an unconfigured
  // `vars.*` interpolates to an empty string, not to a missing variable.
  const modelEnv = process.env.ARKOR_MODEL;
  const config = {
    baseUrl,
    apiKey: process.env.ARKOR_API_KEY ?? "",
    model: modelEnv !== undefined && modelEnv !== "" ? modelEnv : DEFAULT_MODEL,
  };

  // All-or-nothing arguments: pairing a caller's diff with the bundled sample
  // doc would only ever produce a nonsense verdict.
  const args = process.argv.slice(2);
  if (args.length === 1) {
    console.error("Pass both a diff file and at least one doc file.\n");
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const diffPath = args.length > 0 ? args[0] : here("../samples/changes.diff");
  const docPaths =
    args.length > 1 ? args.slice(1) : [here("../samples/doc.md")];

  const diffText = await readText(diffPath, "diff");
  if (diffText.length > MAX_TEXT_CHARS) {
    console.error(
      `note: diff exceeds ${String(MAX_TEXT_CHARS)} chars and was truncated`,
    );
  }
  if (diffText.trim() === "") {
    console.log("No code changes to check; done.");
    return;
  }

  const results: { path: string; verdict: Verdict }[] = [];
  for (const docPath of docPaths) {
    const docText = await readText(docPath, "documentation");
    if (docText.length > MAX_TEXT_CHARS) {
      console.error(
        `note: ${docPath} exceeds ${String(MAX_TEXT_CHARS)} chars and was truncated`,
      );
    }
    const verdict = await requestVerdict(config, docText, diffText);
    results.push({ path: docPath, verdict });

    if (verdict.drifted) {
      console.log(`DRIFT ${docPath} [${verdict.severity}]`);
      console.log(`  why: ${verdict.explanation}`);
      if (verdict.suggestion) console.log(`  fix: ${verdict.suggestion}`);
    } else {
      console.log(`ok    ${docPath}`);
    }
  }

  await writeStepSummary(results);

  if (results.some(({ verdict }) => verdict.drifted)) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
