# Arkor

> Fine-tune and deploy open-weight models with TypeScript.

Arkor is a TypeScript framework for improving and shipping custom open-weight
models. The audience is product engineers who already build with TypeScript /
Next.js and want custom model behaviour without standing up an ML
infrastructure team. Arkor handles GPUs, fine-tuning, and serving underneath
so the user's job stays "write some TypeScript".

> Status: alpha (`0.0.1-alpha.0`). Public APIs may change without notice.

## Quickstart

```bash
pnpm create arkor my-app
cd my-app
pnpm install
pnpm arkor login       # Auth0 PKCE flow; --anonymous also works
pnpm arkor dev         # opens the local Studio GUI on http://127.0.0.1:4000
```

`arkor dev` is the primary surface — it starts a local Studio with hot
reload over your TypeScript and a GUI for running training, inspecting jobs,
and trying out checkpoints in a Playground.

CLI-only flow (no GUI):

```bash
pnpm arkor build       # bundles src/arkor/ into .arkor/build/index.mjs
pnpm arkor start       # runs the build artifact on the cloud
```

## What's in a project

```
my-app/
├── src/arkor/
│   ├── index.ts        # umbrella — `createArkor({ trainer })`
│   └── trainer.ts      # `createTrainer({ name, model, dataset, ... })`
├── arkor.config.ts     # training defaults
├── .arkor/             # state + build artifact (gitignored)
└── package.json
```

The umbrella is what the CLI and Studio discover. Per-role primitives —
`trainer` today, `deploy` and `eval` later — live in sibling files and get
gathered on `createArkor`. Adding a new primitive is "drop a file, register
it on the umbrella": no scaffold change required.

## CLI

| Command | Purpose |
|---|---|
| `arkor init` | Scaffold a new project in the current directory |
| `arkor login` / `logout` / `whoami` | Auth0 PKCE / anonymous tokens |
| `arkor dev` | Launch the local Studio (hot reload + GUI) |
| `arkor build` | Bundle `src/arkor/index.ts` to `.arkor/build/index.mjs` |
| `arkor start` | Run the build artifact (auto-builds when missing) |

`pnpm dev` resolves to `arkor dev` in scaffolded projects, so most workflows
live behind that one command.

## Packages

| Package | What it is |
|---|---|
| [`arkor`](packages/arkor) | The SDK + CLI + bundled local Studio |
| [`create-arkor`](packages/create-arkor) | `pnpm create arkor` scaffolder |

## Requirements

- Node.js 22.6+ (the SDK relies on stable APIs from that line)
- pnpm / npm / yarn / bun all work for installs

## License

UNLICENSED — see individual package metadata.
