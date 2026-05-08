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

// The three demo templates below pair `unsloth/gemma-4-e4b-it` with curated
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

const REDACTION_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "redaction-run",
  model: "unsloth/gemma-4-e4b-it",
  dataset: { type: "huggingface", name: "arkorlab/redaction-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  evalSteps: 25,
  lora: { r: 16, alpha: 16, loadIn4bit: false },
  // Set dryRun: true for a fast end-to-end smoke test before a full run.
  // dryRun: true,
  callbacks: {
    onLog: ({ step, loss, evalLoss }) => {
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
    },
  },
});
`;

const TRANSLATE_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "translate-run",
  model: "unsloth/gemma-4-e4b-it",
  dataset: { type: "huggingface", name: "arkorlab/translate-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  evalSteps: 25,
  lora: { r: 16, alpha: 16, loadIn4bit: false },
  // dryRun: true,
  callbacks: {
    onLog: ({ step, loss, evalLoss }) => {
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
    },
  },
});
`;

const TRIAGE_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "triage-run",
  model: "unsloth/gemma-4-e4b-it",
  dataset: { type: "huggingface", name: "arkorlab/triage-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  evalSteps: 25,
  lora: { r: 16, alpha: 16, loadIn4bit: false },
  // dryRun: true,
  callbacks: {
    onLog: ({ step, loss, evalLoss }) => {
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

export const STARTER_CONFIG = `// Training defaults. Project routing (orgSlug / projectSlug) is tracked
// automatically in .arkor/state.json — do not put it here.
export default {};
`;

export const STARTER_README = (name: string) => `# ${name}

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
- \`src/arkor/trainer.ts\` — your trainer (\`createTrainer({...})\`). Add
  sibling files for future primitives (\`deploy.ts\`, \`eval.ts\`) and
  register them in the \`createArkor\` call.
- \`arkor.config.ts\` — training defaults. Project routing lives in
  \`.arkor/state.json\`, managed by the CLI.

Requires Node.js >= 22.22.0.
`;
