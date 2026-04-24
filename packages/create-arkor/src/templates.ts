/**
 * Starter templates written out by `create-arkor` / `arkor init`.
 *
 * Keep these aligned with the equivalent templates in
 * `arkor/src/cli/commands/init.ts` until we extract a shared package.
 */
export type TemplateId = "minimal" | "alpaca" | "chatml";

export const TEMPLATES: Record<TemplateId, { label: string; hint: string; entry: string }> = {
  minimal: {
    label: "Minimal",
    hint: "bare createTrainer call",
    entry: `import { createTrainer } from "arkor";

export default createTrainer({
  name: "my-first-run",
  config: {
    model: "unsloth/gemma-4-E4B-it",
    datasetSource: {
      type: "huggingface",
      name: "yahma/alpaca-cleaned",
      split: "train[:500]",
    },
    maxSteps: 50,
    loraR: 16,
    loraAlpha: 16,
  },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`,
  },
  alpaca: {
    label: "Alpaca",
    hint: "instruction-tuning + mid-training eval",
    entry: `import { createTrainer } from "arkor";

export default createTrainer({
  name: "alpaca-run",
  config: {
    model: "unsloth/gemma-4-E4B-it",
    datasetSource: {
      type: "huggingface",
      name: "yahma/alpaca-cleaned",
      split: "train[:1000]",
    },
    datasetFormat: { type: "alpaca" },
    maxSteps: 100,
    loraR: 16,
    loraAlpha: 16,
  },
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
`,
  },
  chatml: {
    label: "ChatML",
    hint: "multi-turn chat fine-tuning",
    entry: `import { createTrainer } from "arkor";

export default createTrainer({
  name: "chatml-run",
  config: {
    model: "unsloth/gemma-4-E4B-it",
    datasetSource: {
      type: "huggingface",
      name: "stingning/ultrachat",
      split: "train[:500]",
    },
    datasetFormat: { type: "chatml" },
    maxSteps: 100,
    loraR: 16,
    loraAlpha: 16,
  },
  callbacks: {
    onLog: ({ step, loss }) => console.log(\`step=\${step} loss=\${loss}\`),
  },
});
`,
  },
};

export const STARTER_CONFIG = `// Training defaults. Project routing (orgSlug / projectSlug) is tracked
// automatically in .arkor/state.json — do not put it here.
export default {};
`;

export const STARTER_README = (name: string) => `# ${name}

An arkor training project scaffolded by \`create-arkor\`.

## Getting started

\`\`\`
pnpm install        # or npm install / yarn
pnpm arkor login    # optional; anonymous tokens work too
pnpm arkor train    # runs src/arkor/index.ts on the cloud
pnpm arkor dev      # opens the local Studio GUI
\`\`\`

## Files

- \`src/arkor/index.ts\` — your training entry (loaded via Node's
  \`--experimental-strip-types\`).
- \`arkor.config.ts\` — training defaults. Project routing lives in
  \`.arkor/state.json\`, managed by the CLI.

Requires Node.js >= 22.6.
`;
