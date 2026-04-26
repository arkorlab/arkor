/**
 * Starter templates written out by `create-arkor` / `arkor init`.
 * Single source of truth — both consumers bundle this module at build time.
 *
 * Layout written to disk:
 *
 *   src/arkor/index.ts    ← umbrella manifest (`createArkor({ trainer })`)
 *   src/arkor/trainer.ts  ← per-template trainer (`createTrainer({...})`)
 *
 * `index.ts` is identical across templates — only the trainer body differs.
 */
export type TemplateId = "minimal" | "alpaca" | "chatml";

export interface Template {
  label: string;
  hint: string;
  /** Body of `src/arkor/trainer.ts` for this template. */
  trainer: string;
}

const MINIMAL_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "my-first-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: {
    type: "huggingface",
    name: "yahma/alpaca-cleaned",
    split: "train[:500]",
  },
  maxSteps: 50,
  lora: { r: 16, alpha: 16 },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`;

const ALPACA_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "alpaca-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: {
    type: "huggingface",
    name: "yahma/alpaca-cleaned",
    split: "train[:1000]",
  },
  datasetFormat: { type: "alpaca" },
  maxSteps: 100,
  lora: { r: 16, alpha: 16 },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
    onCheckpoint: async ({ step, infer }) => {
      const res = await infer({
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      });
      console.log(\`ckpt @ \${step}:\`, await res.text());
    },
  },
});
`;

const CHATML_TRAINER = `import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "chatml-run",
  model: "unsloth/gemma-4-E4B-it",
  dataset: {
    type: "huggingface",
    name: "stingning/ultrachat",
    split: "train[:500]",
  },
  datasetFormat: { type: "chatml" },
  maxSteps: 100,
  lora: { r: 16, alpha: 16 },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`;

export const TEMPLATES: Record<TemplateId, Template> = {
  minimal: {
    label: "Minimal",
    hint: "bare createTrainer call",
    trainer: MINIMAL_TRAINER,
  },
  alpaca: {
    label: "Alpaca",
    hint: "instruction-tuning + mid-training eval",
    trainer: ALPACA_TRAINER,
  },
  chatml: {
    label: "ChatML",
    hint: "multi-turn chat fine-tuning",
    trainer: CHATML_TRAINER,
  },
};

/**
 * Body of `src/arkor/index.ts` — identical across templates. The umbrella
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

- \`src/arkor/index.ts\` — umbrella manifest (\`createArkor({ trainer })\`).
  This is what the CLI and Studio discover.
- \`src/arkor/trainer.ts\` — your trainer (\`createTrainer({...})\`). Add
  sibling files for future primitives (\`deploy.ts\`, \`eval.ts\`) and
  register them on the umbrella.
- \`arkor.config.ts\` — training defaults. Project routing lives in
  \`.arkor/state.json\`, managed by the CLI.

Requires Node.js >= 22.6.
`;
