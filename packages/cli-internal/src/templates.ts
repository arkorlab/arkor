/**
 * Starter templates written out by `create-arkor` / `arkor init`.
 * Single source of truth — both consumers bundle this module at build time.
 *
 * Layout written to disk:
 *
 *   src/arkor/index.ts    ← entry-point manifest (`createArkor({ trainer })`)
 *   src/arkor/trainer.ts  ← per-template trainer (`createTrainer({...})`)
 *
 * `index.ts` is identical across templates — only the trainer body differs.
 */
export type TemplateId = "redaction" | "translate" | "triage";

export interface Template {
  label: string;
  hint: string;
  /** Body of `src/arkor/trainer.ts` for this template. */
  trainer: string;
}

// The three demo templates below pair `unsloth/gemma-4-E4B-it` with curated
// HuggingFace datasets published under the `arkorlab` org. Each dataset is in
// OpenAI messages format (chatml), one sample per JSONL line, with the system
// prompt baked into the conversation - so `datasetFormat: { type: "chatml" }`
// hands the right shape to the trainer's apply_chat_template step.
//
// `evalSteps: 25` is wired in by default so a fresh scaffold produces both
// training and eval loss out of the box — Studio's loss chart picks the
// `evalLoss` series up automatically, and `onLog` prints it on the steps
// where the trainer actually evaluates (`evalLoss` is null on non-eval
// steps, so the segment is omitted there).
//
// Use `dryRun: true` for a 2-3 minute smoke test (50 rows, max_steps=10) before
// committing to a full run.

// Shared `onLog` body interpolated into every trainer template below so
// the formatter stays in lock-step across `triage` / `translate` /
// `redaction`. Indentation is baked into this constant (`    ` for the
// `onLog:` line, `      ` for the body), and the `${ONLOG_BODY}`
// interpolation in each trainer string sits at column 0 with **no
// leading space** — adding one would push the rendered `onLog:` block
// one column right of the surrounding `callbacks: {`. Reviewers / bots
// occasionally flag the bare `${ONLOG_BODY}` line as misaligned because
// neighbouring source lines (`  callbacks: {` above, `  },` below)
// carry their own leading whitespace; that read is wrong, the rendered
// output lines up correctly. Verify by running
// `pnpm --filter @arkor/cli-internal exec node --input-type=module -e
// "import('./src/templates.ts').then(m =>
// process.stdout.write(m.TEMPLATES.triage.trainer))"` before changing
// the indentation.
//
// Escaping note: this string is itself a JS template literal whose
// product is the *runtime* trainer-source backticks/interpolations. So
// `\`` and `\${...}` here become `` ` `` and `${...}` in the emitted
// source code — exactly what the user-visible `console.log` template
// literal needs.
const ONLOG_BODY = `    onLog: ({ step, loss, evalLoss }) => {
      // Omit each \`field=…\` segment when its value isn't a finite number
      // so the line stays readable on eval-only steps (where \`loss\` is
      // null) and on training-only steps (where \`evalLoss\` is null) —
      // matches the format Studio's event log uses.
      const lossPart =
        typeof loss === "number" && Number.isFinite(loss)
          ? \` loss=\${loss.toFixed(4)}\`
          : "";
      const evalPart =
        typeof evalLoss === "number" && Number.isFinite(evalLoss)
          ? \` evalLoss=\${evalLoss.toFixed(4)}\`
          : "";
      console.log(\`step=\${step}\${lossPart}\${evalPart}\`);
    },`;

const REDACTION_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "redaction-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/redaction-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  evalSteps: 25,
  lora: { r: 16, alpha: 16, loadIn4bit: false },
  // Set dryRun: true for a fast end-to-end smoke test before a full run.
  // dryRun: true,
  callbacks: {
${ONLOG_BODY}
    // See /cookbook/structured-outputs to add a JSON-schema mid-run check
    // (e.g. force \`{ redactedText, redactedCount, tags }\`) here.
  },
});
`;

const TRANSLATE_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "translate-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/translate-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  evalSteps: 25,
  lora: { r: 16, alpha: 16, loadIn4bit: false },
  // dryRun: true,
  callbacks: {
${ONLOG_BODY}
    // See /cookbook/structured-outputs to add a JSON-schema mid-run check
    // (e.g. force \`{ translation, detectedLanguage }\`) here.
  },
});
`;

const TRIAGE_TRAINER = `import { createTrainer } from "arkor";

const TRIAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    category: { type: "string" },
    urgency: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
    nextAction: { type: "string" },
  },
  required: ["category", "urgency", "summary", "nextAction"],
  additionalProperties: false,
};

interface TriageOutput {
  category: string;
  urgency: "low" | "medium" | "high";
  summary: string;
  nextAction: string;
}

export const trainer = createTrainer({
  name: "triage-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/triage-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  evalSteps: 25,
  lora: { r: 16, alpha: 16, loadIn4bit: false },
  // dryRun: true,
  callbacks: {
${ONLOG_BODY}
    // Mid-run sanity check: force the half-trained model to return the
    // triage object shape via JSON Schema, then log it. See
    // /cookbook/structured-outputs for the full pattern (and how to wire
    // this up to early-stopping based on the typed fields).
    onCheckpoint: async ({ step, infer }) => {
      try {
        const res = await infer({
          messages: [
            { role: "user", content: "I can't log in to my account." },
          ],
          stream: false,
          maxTokens: 200,
          responseFormat: {
            type: "json_schema",
            json_schema: {
              name: "triage",
              schema: TRIAGE_SCHEMA,
              strict: true,
            },
          },
        });
        const data = (await res.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        const content = data.choices[0]?.message.content;
        if (content === undefined || content === "") {
          throw new Error("triage check returned empty content");
        }
        const parsed = JSON.parse(content) as TriageOutput;
        console.log(\`step=\${step} triage=\`, parsed);
      } catch (err) {
        console.error(\`step=\${step} triage check failed:\`, err);
      }
    },
  },
});
`;

// Order is significant — `templateChoices()` preserves insertion order so the
// CLI prompt lists demos first (sorted by estimated training time).
//
// Estimated training times assume A100 80GB on Runpod Serverless with the
// template defaults (maxSteps: 100, batchSize: 4, LoRA r=16, full precision).
// Real numbers depend on GPU availability + cold-start; treat them as ballparks.
export const TEMPLATES: Record<TemplateId, Template> = {
  triage: {
    label: "Triage",
    hint: "Support ticket triage (estimated training: ~7 min)",
    trainer: TRIAGE_TRAINER,
  },
  translate: {
    label: "Translate",
    hint: "Multilingual intake translation across 9 languages (estimated training: ~7 min)",
    trainer: TRANSLATE_TRAINER,
  },
  redaction: {
    label: "Redaction",
    hint: "PII redaction → structured JSON (estimated training: ~12 min)",
    trainer: REDACTION_TRAINER,
  },
};

/**
 * Body of `src/arkor/index.ts` — identical across templates. The `createArkor`
 * factory is what `arkor build` / Studio discovers; per-role primitives
 * (`trainer`, future `deploy`, `eval`) live in sibling files and get gathered
 * here.
 */
export const STARTER_INDEX = `import { createArkor } from "arkor";
import { trainer } from "./trainer";

export const arkor = createArkor({ trainer });
`;

export const STARTER_CONFIG = `// Placeholder for future project-level config — the runtime does not read
// fields from this file yet. Training settings (\`maxSteps\`, \`lora\`, etc.)
// live on the Trainer in src/arkor/trainer.ts. Project routing
// (orgSlug / projectSlug) is tracked automatically in .arkor/state.json.
export default {};
`;

/**
 * Body of the scaffolded `README.md`.
 *
 * `agentsMd` controls whether the AGENTS.md / CLAUDE.md bullet appears
 * in the Files section: it must mirror what the scaffolder actually
 * wrote to disk, otherwise a project created with `--no-agents-md`
 * would ship a README that documents files that do not exist.
 */
export const STARTER_README = (
  name: string,
  options: { agentsMd: boolean } = { agentsMd: true },
) => `# ${name}

An arkor training project scaffolded by \`create-arkor\`.

## Getting started

The \`dev\` / \`build\` / \`start\` package scripts forward to the matching
\`arkor\` subcommands, so the script form works across every package
manager (\`npm\` does not run package binaries via \`npm <bin>\` — use
\`npm run <script>\` or \`npx arkor <subcommand>\`).

\`\`\`
npm install && npm run dev
# or: pnpm install && pnpm dev
# or: yarn && yarn dev
# or: bun install && bun dev
\`\`\`

\`arkor dev\` opens the local Studio GUI (most workflows live there).

Optional — log in to your own org instead of using anonymous tokens:

\`\`\`
npx arkor login
\`\`\`

CLI-only flow (no GUI):

\`\`\`
npm run build    # bundles src/arkor/ into .arkor/build/index.mjs
npm run start    # runs the build artifact on the cloud
\`\`\`

## Files

- \`src/arkor/index.ts\` — entry-point manifest (\`createArkor({ trainer })\`).
  This is what the CLI and Studio discover.
- \`src/arkor/trainer.ts\` — your trainer (\`createTrainer({...})\`). Training
  settings (\`maxSteps\`, \`lora\`, etc.) live on the Trainer itself. Add
  sibling files for future primitives (\`deploy.ts\`, \`eval.ts\`) and
  register them in the \`createArkor\` call.
- \`arkor.config.ts\` — placeholder for future project-level config. The
  runtime does not read fields from this file yet. Project routing lives
  in \`.arkor/state.json\`, managed by the CLI.${
    options.agentsMd
      ? `
- \`AGENTS.md\` / \`CLAUDE.md\` — instructions for AI coding agents,
  briefing them that arkor post-dates their training data. When the
  scaffolder creates \`CLAUDE.md\` itself it is a one-liner that imports
  \`AGENTS.md\` via the Claude Code \`@<path>\` directive; if you already
  had a project-specific \`CLAUDE.md\`, the scaffolder leaves it alone
  and your existing instructions stay authoritative. To opt out of
  these files in **future** scaffolds, pass \`--no-agents-md\` to
  \`create-arkor\` / \`arkor init\`; the flag does not delete files that
  are already on disk, so remove them by hand if you no longer want
  them.`
      : ""
  }

Requires Node.js >= 22.22.0.
`;
