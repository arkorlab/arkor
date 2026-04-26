# create-arkor

Scaffolder for [Arkor](https://github.com/arkorlab/arkor) projects. Run via
`npm create` / `pnpm create` / `yarn create` / `bun create`.

> Status: alpha (`0.0.1-alpha.0`).

## Usage

```bash
npm create arkor@latest my-app
# or:
pnpm create arkor my-app
yarn create arkor my-app
bun create arkor my-app
```

Interactive by default. Pass flags to skip prompts:

```bash
pnpm create arkor my-app \
  --template alpaca \
  --use-pnpm \
  --skip-install \
  --skip-git
```

## Flags

| Flag | Effect |
|---|---|
| `[dir]` (positional) | Target directory; defaults to the current one |
| `--name <name>` | Project name (sanitised for `package.json`) |
| `--template <id>` | `minimal` / `alpaca` / `chatml` |
| `-y`, `--yes` | Accept defaults instead of prompting |
| `--skip-install` | Don't run `<pm> install` after scaffolding |
| `--use-npm` / `--use-pnpm` / `--use-yarn` / `--use-bun` | Force a package manager (otherwise auto-detected from `npm_config_user_agent`) |
| `--git` / `--skip-git` | Initialise a git repo with an initial commit, or skip the prompt |

## What it writes

```
my-app/
├── src/arkor/
│   ├── index.ts        # createArkor({ trainer }) umbrella
│   └── trainer.ts      # template-specific createTrainer({...})
├── arkor.config.ts
├── README.md
├── .gitignore          # node_modules/, dist/, .arkor/
└── package.json        # scripts: dev / build / start
```

Existing files are kept (never overwritten). `package.json` is patched in
place — only missing keys are added, so a hand-edited `build: "tsc"` survives.

## Templates

- **minimal** — bare `createTrainer` call, the smallest working example.
- **alpaca** — instruction-tuning with a mid-training `onCheckpoint` that
  fires an `infer({...})` against the in-progress adapter.
- **chatml** — multi-turn chat fine-tuning on `stingning/ultrachat`.

The umbrella `src/arkor/index.ts` is identical across templates; only
`src/arkor/trainer.ts` differs.

## Next step

After scaffolding:

```bash
cd my-app
<pm> install
<pm> run dev          # npm run dev / pnpm dev / yarn dev / bun dev
```

The `dev` / `build` / `start` package scripts forward to the corresponding
`arkor` subcommands, so the script form works the same across npm, pnpm,
yarn, and bun. (npm in particular does *not* run package binaries via
`npm <bin>` — use `npm run <script>`, or `npx arkor <subcommand>` for
one-off invocations.)

`arkor dev` opens the local Studio. See the
[`arkor` package README](../arkor/README.md) for the full SDK + CLI
reference.
