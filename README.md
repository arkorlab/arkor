<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Arkor" width="96">
  </picture>
</p>

<h1 align="center">Arkor</h1>

<h3 align="center">The TypeScript framework for fine-tuning open-weight LLMs</h3>

<p align="center">
  Ship custom open-weight models the same way you ship your TypeScript app.
  Type-safe configs, a local Studio (web UI) to start and watch runs, and managed GPUs.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/arkor"><img src="https://img.shields.io/npm/v/arkor?label=arkor&color=000" alt="npm"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-000" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.6-000" alt="node ≥22.6">
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="alpha">
  <a href="https://discord.gg/YujCZYGrEZ"><img src="https://img.shields.io/badge/discord-join-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &nbsp;·&nbsp;
  <a href="#why-arkor"><strong>Why Arkor</strong></a> &nbsp;·&nbsp;
  <a href="https://docs.arkor.ai"><strong>Docs</strong></a>
</p>

> [!WARNING]
> Arkor is **alpha**. APIs change without notice. We're shipping in public, and feedback shapes what lands next.

<!--
  Demo media goes here once recorded:
    - assets/demo-cli.gif       Terminalizer: pnpm create arkor → pnpm dev
    - assets/demo-studio.gif    Screen recording: Run Training → loss curve → Playground
-->

## Quickstart

```bash
pnpm create arkor my-arkor-app
cd my-arkor-app
pnpm dev
```

**No signup required:** 
`arkor dev` opens **Studio**, a local web UI at `http://localhost:4000`. On first launch it signs you in via Arkor Cloud OAuth, so you can fire off a real training run right away. 

Pass `--anonymous` to `arkor login` if you'd rather skip the account flow and use a throwaway workspace.

### Pick a template

The scaffolder asks which template you want.
All three pair the same small open-weight base (`unsloth/gemma-4-E4B-it`) with a curated public dataset on HuggingFace, so the first run finishes in minutes.

| Template    | Task            | Example                                                                                          | Dataset                     | Est. training |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------ | --------------------------- | ------------- |
| `triage`    | Support triage  | `"Can't log in"` → `{category: "auth", urgency: "high", summary: "...", nextAction: "..."}`      | `arkorlab/triage-demo`      | ~7 min        |
| `translate` | Translation     | `"パスワードを忘れました"` → `{translation: "I forgot my password", detectedLanguage: "ja"}`     | `arkorlab/translate-demo`   | ~7 min        |
| `redaction` | PII redaction   | `"Email john@x.com"` → `{redactedText: "Email [REDACTED]", redactedCount: 1, tags: ["EMAIL"]}`   | `arkorlab/redaction-demo`   | ~12 min       |

Skip the prompt with `pnpm create arkor my-arkor-app --template triage`.

## Why Arkor

Custom open-weight models are a real option today because of years of work in the Python ML ecosystem and the people and companies who built it out. 
Arkor stands on that foundation.

What we wanted, and didn't find, was a path that fits how TypeScript and Node developers already work: a workflow where fine-tuning, evaluation, and serving live in the same codebase as the product, with the same editor, types, and review flow. 

Type-safe configs instead of separate config files. A local Studio for the dev loop.

The phrase we keep coming back to: **ship the model the same way you ship the product.** If that sounds right, you're the audience.

## What works today

- [x] **Fine-tune an open-weight LLM from one file.** `createTrainer({ model, dataset, lora, ... })` runs LoRA training on the base model you point it at.
- [x] **Three curated templates that run end-to-end.** `triage`, `translate`, and `redaction` pair the same Gemma 4 base with a public HuggingFace dataset and finish in minutes.
- [x] **React to training in code, not in a dashboard.** Lifecycle callbacks (`onStarted`, `onLog`, `onCheckpoint`, `onCompleted`, `onFailed`) fire as the run streams from the cloud, fully typed.
- [x] **Sanity-check the model before the run finishes.** Inside `onCheckpoint`, call `infer({ messages })` against the model as it's being trained.
- [x] **Watch the run in a local Studio.** `arkor dev` opens a UI with a jobs list, live loss chart, log tail, and a Playground for chatting with your fine-tuned models.
- [x] **Try it without an account.** `arkor login` runs Arkor Cloud OAuth (PKCE) and attaches the work to your account; pass `--anonymous` to get a throwaway workspace instead.

## What's coming next

### Framework API

- [ ] **Generate synthetic training data from a small seed set.**
- [ ] **Distillation-focused templates** that pair compatible teacher and student models.
- [ ] **Templates aimed at small, on-device models** (WebGPU, mobile).

### SDK and CLI

- [ ] **Train on a local GPU.** Today every run goes to Arkor's managed GPUs.
- [ ] **Bring your own dataset from a JSONL file.** Today, any HuggingFace name and any blob URL (with optional auth token) already work.
- [ ] **More base models beyond Gemma 4.**

### Studio

- [ ] **Download a trained model as a file** and run it on your own machine or deploy target. Today, runs stay on Arkor's managed inference.
- [ ] **Surface the dry-run option in the UI** for fast smoke tests.

### Other

- [ ] **Self-host the training backend.** Today we host it.
- [x] **A real documentation site.** Sources live in [`docs/`](docs); the published site is [docs.arkor.ai](https://docs.arkor.ai).

## A taste of the API

```ts
// src/arkor/trainer.ts
import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "support-bot-v1",
  model: "unsloth/gemma-4-E4B-it",
  dataset: { type: "huggingface", name: "arkorlab/triage-demo" },
  lora: { r: 16, alpha: 16 },
  maxSteps: 100,
  callbacks: {
    onLog: ({ step, loss }) => console.log(`step=${step} loss=${loss}`),
    onCheckpoint: async ({ step, infer }) => {
      const res = await infer({ messages: [{ role: "user", content: "Hello!" }] });
      console.log(`ckpt @ ${step}:`, await res.text());
    },
  },
});
```

```ts
// src/arkor/index.ts  ← discovered by `arkor dev` / `arkor build`
import { createArkor } from "arkor";
import { trainer } from "./trainer";

export const arkor = createArkor({ trainer });
```

`src/arkor/index.ts` is the file the CLI and Studio look for. 
Your `trainer` lives in a sibling file and is registered through `createArkor`.

<!--
  Studio screenshots go here once captured:
    - assets/studio-jobs.png        Jobs list
    - assets/studio-chart.png       Live loss + log tail
    - assets/studio-playground.png  Playground chat
-->

## What's in a project

```
my-arkor-app/
├── src/arkor/
│   ├── index.ts        # createArkor({ trainer })  ← discovered by the CLI / Studio
│   └── trainer.ts      # createTrainer({ ... })
├── arkor.config.ts
├── .arkor/             # state + build artifacts (gitignored)
└── package.json        # dev / build / start
```

## CLI

| Command                              | Purpose                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `arkor init`                         | Scaffold a new project in the current directory                        |
| `arkor login` / `logout` / `whoami`  | Arkor Cloud OAuth (PKCE) / anonymous tokens                            |
| `arkor dev`                          | Launch the local Studio web UI                                         |
| `arkor build`                        | Bundle `src/arkor/index.ts` to `.arkor/build/index.mjs`                |
| `arkor start`                        | Run the build artifact (auto-builds when missing)                      |

`pnpm dev` resolves to `arkor dev` in scaffolded projects, so most workflows live behind that one command.

## Architecture

`arkor dev` boots a [Hono](https://hono.dev) server on `127.0.0.1:4000` that serves a Vite + React SPA from the same origin. 

The SPA talks to your code via per-launch CSRF-token-gated `/api/*` routes (loopback-only, with a `Host` header guard against DNS rebinding); your code talks to the Arkor training backend over authenticated HTTPS. 

Training runs on managed GPUs; checkpoints stream back as SSE events that fire your `callbacks.*` in process.

## Repository

| Package                                        | What it is                                  |
| ---------------------------------------------- | ------------------------------------------- |
| [`arkor`](packages/arkor)                      | SDK + CLI + bundled local Studio            |
| [`create-arkor`](packages/create-arkor)        | `pnpm create arkor` scaffolder              |
| [`docs`](docs)                                 | Mintlify source for [docs.arkor.ai](https://docs.arkor.ai) (`pnpm --filter @arkor/docs docs:dev`) |

Requires Node.js 22.6+. 
(Please use Node.js 24, preferably the latest version, for contributing to this repository.)

Works with pnpm / npm / yarn / bun.

## We're shipping in public

Arkor is alpha, and the core idea (TypeScript-native fine-tuning for product engineers) is something we want to design *with* the people who'd use it. 
If that's you:

- **[File an issue](https://github.com/arkorlab/arkor/issues/new)** with the model + dataset + workflow you wish worked. We read everything.
- **Star the repo** if you want updates as we move toward `0.1`.
- **[Join Discord](https://discord.gg/YujCZYGrEZ)** for live discussion and early-access pings.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## License

[MIT](LICENSE.md)
