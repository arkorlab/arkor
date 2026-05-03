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
// prompt baked into the conversation — so `datasetFormat: { type: "chatml" }`
// hands the right shape to the trainer's apply_chat_template step.
//
// Use `dryRun: true` for a 2–3 minute smoke test (50 rows, max_steps=10) before
// committing to a full run.

const REDACTION_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "redaction-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/redaction-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  lora: { r: 16, alpha: 16 },
  // Set dryRun: true for a fast end-to-end smoke test before a full run.
  // dryRun: true,
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
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
  lora: { r: 16, alpha: 16 },
  // dryRun: true,
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`;

const TRIAGE_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "triage-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/triage-demo" },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  lora: { r: 16, alpha: 16 },
  // dryRun: true,
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`;

// Order is significant — `templateChoices()` preserves insertion order so the
// CLI prompt lists demos first (sorted by estimated training time).
//
// Estimated training times assume A100 80GB on Runpod Serverless with the
// template defaults (maxSteps: 100, batchSize: 4, LoRA r=16, 4-bit). Real
// numbers depend on GPU availability + cold-start; treat them as ballparks.
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

Requires Node.js >= 22.6.
`;
