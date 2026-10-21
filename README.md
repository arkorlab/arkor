<p align="center">
  <img src="assets/oddphin-rounded.png" alt="Oddphin, the Arkor mascot" width="96">
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
  <img src="https://img.shields.io/badge/node-%E2%89%A522.22.0-000" alt="node ≥22.22.0">
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="alpha">
  <a href="https://discord.arkor.ai/"><img src="https://img.shields.io/badge/discord-join-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &nbsp;·&nbsp;
  <a href="#why-arkor"><strong>Why Arkor</strong></a> &nbsp;·&nbsp;
  <a href="https://docs.arkor.ai"><strong>Docs</strong></a>
</p>

<p align="center">
  <a href="README.ja.md">日本語</a>
</p>

# Arkor Fine-tuning

> [!IMPORTANT]
> The arkor.ai fine-tuning service has been discontinued, and this framework is no longer maintained.
> The source code and contribution history will remain publicly available under the MIT license.

This repository contains the original fine-tuning framework: a TypeScript SDK, CLI, and local Studio previously offered alongside the arkor.ai cloud service.

## Project status

- The hosted training and inference services are no longer available.
- No further updates, bug fixes, or releases are planned.
- The source code remains available for reference and reuse under the MIT license.

The original cloud-connected workflows relied on the discontinued Arkor Cloud backend. This repository does not include a replacement for that backend.

## Thank you

Thank you to everyone who used Arkor’s fine-tuning service, contributed code, submitted pull requests, reported issues, or shared feedback. We appreciate the time and care you put into this project.

We recognize that ending maintenance affects people who invested their time in the project, particularly those with outstanding contributions. We’re sorry we didn’t communicate this decision sooner.

## Our current work

Our work continues at [arkor.dev](https://arkor.dev).

## Technical documentation

> [!NOTE]
> The sections below describe the framework and service before discontinuation.
> Cloud-dependent onboarding, authentication, training, and inference are no longer available. The examples are preserved as historical documentation.

### Design goals

The fine-tuning framework was designed to bring model development into the workflow TypeScript and Node developers already used: the same codebase, editor, types, and review process as their application.

Its design centered on type-safe configuration, lifecycle callbacks, and a local Studio for the development loop, building on the Python ML ecosystem.

The original goal was: **ship the model the same way you ship the product.**

### Features

- **Fine-tuning from a TypeScript file.** `createTrainer({ model, dataset, lora, ... })` configured LoRA training against a supported base model.
- **Three curated templates.** `triage`, `translate`, and `redaction` paired a Gemma 4 base model with public HuggingFace datasets.
- **Typed lifecycle callbacks.** `onStarted`, `onLog`, `onCheckpoint`, `onCompleted`, and `onFailed` exposed training events to application code.
- **Checkpoint inference.** Inside `onCheckpoint`, `infer({ messages })` could test a checkpoint while training was still running.
- **Local Studio.** `arkor dev` opened a web UI with a jobs list, loss chart, logs, and a Playground.
- **Anonymous workspaces and OAuth.** The original onboarding flow supported anonymous workspaces that could later be attached to an account.

### Quickstart

The original project creation flow was:

```bash
pnpm create arkor my-arkor-app
cd my-arkor-app
pnpm dev
```

`arkor dev` opened Studio at `http://localhost:4000`. On first launch, it provisioned an anonymous workspace through Arkor Cloud.

`arkor login --oauth` started the OAuth flow to attach that workspace to an account.

These cloud-dependent steps no longer work following the service shutdown.

#### Templates

The scaffolder offered three templates using `gemma-4-E4B-it` and curated public HuggingFace datasets.

| Template | Task | Example | Dataset | Historical training estimate |
| --- | --- | --- | --- | --- |
| `triage` | Support triage | `"Can't log in"` → `{category: "auth", urgency: "high", summary: "...", nextAction: "..."}` | `arkorlab/triage-demo` | ~7 min |
| `translate` | Translation | `"パスワードを忘れました"` → `{translation: "I forgot my password", detectedLanguage: "ja"}` | `arkorlab/translate-demo` | ~7 min |
| `redaction` | PII redaction | `"Email john@x.com"` → `{redactedText: "Email [REDACTED]", redactedCount: 1, tags: ["EMAIL"]}` | `arkorlab/redaction-demo` | ~12 min |

A template could be selected directly:

```bash
pnpm create arkor my-arkor-app --template triage
```

### API example

The following example illustrates the former cloud-backed training API.

```ts
// src/arkor/trainer.ts
import { createTrainer } from "arkor";

export const trainer = createTrainer({
  name: "support-bot-v1",
  model: "unsloth/gemma-4-E4B-it",
  dataset: {
    type: "huggingface",
    name: "arkorlab/triage-demo",
  },
  lora: {
    r: 16,
    alpha: 16,
  },
  maxSteps: 100,
  callbacks: {
    onLog: ({ step, loss }) => {
      console.log(`step=${step} loss=${loss}`);
    },
    onCheckpoint: async ({ step, infer }) => {
      const res = await infer({
        messages: [{ role: "user", content: "Hello!" }],
      });
      console.log(`ckpt @ ${step}:`, await res.text());
    },
  },
});
```

```ts
// src/arkor/index.ts
import { createArkor } from "arkor";
import { trainer } from "./trainer";

export const arkor = createArkor({ trainer });
```

The CLI and Studio discovered `src/arkor/index.ts`. Trainers were registered through `createArkor`.

### Project structure

| Path | Purpose |
| --- | --- |
| `src/arkor/index.ts` | Application entry point discovered by the CLI and Studio |
| `src/arkor/trainer.ts` | Trainer configuration and callbacks |
| `arkor.config.ts` | Project configuration |
| `.arkor/` | Local state and build artifacts, excluded from Git |
| `package.json` | Project scripts and dependencies |

### CLI

| Command | Purpose |
| --- | --- |
| `arkor init` | Scaffold a project in the current directory |
| `arkor login` / `arkor logout` / `arkor whoami` | Manage Arkor Cloud authentication |
| `arkor dev` | Launch the local Studio web UI |
| `arkor build` | Bundle `src/arkor/index.ts` into `.arkor/build/index.mjs` |
| `arkor start` | Run the build artifact, building it first if missing |

In scaffolded projects, `pnpm dev` resolved to `arkor dev`.

Authentication and cloud-backed operations depended on the discontinued service.

### Architecture

`arkor dev` started a [Hono](https://hono.dev) server on `127.0.0.1:4000`, serving a Vite + React SPA from the same origin.

The Studio server rejected non-loopback `Host` headers before serving HTML. The SPA communicated with local application code through `/api/*` routes protected by a CSRF token generated for each launch.

Application code connected to the Arkor training backend over authenticated HTTPS. Training ran on managed GPUs, and training events and checkpoints streamed back through SSE to invoke the configured lifecycle callbacks.

### Repository packages

| Package | Contents |
| --- | --- |
| [`arkor`](packages/arkor) | SDK, CLI, and bundled local Studio |
| [`create-arkor`](packages/create-arkor) | Project scaffolder |
| [`docs`](docs) | Historical documentation source |

### Runtime and development

The documented runtime requirement was Node.js 22.22.0 or later. Node.js 24 was recommended for repository development.

The project supported pnpm, npm, yarn, and bun.

Historical development setup instructions are preserved in [CONTRIBUTING.md](CONTRIBUTING.md), and further technical documentation is available in the [`docs`](docs/) directory.

## Maintenance

Official development and maintenance have ended. We are no longer accepting contributions for future official releases.

The existing code, pull requests, and contribution history are being preserved as part of the project’s public record.

## License

[MIT](LICENSE.md)
