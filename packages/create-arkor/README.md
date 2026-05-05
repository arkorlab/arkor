# create-arkor

Scaffolder for [Arkor](https://github.com/arkorlab/arkor) projects. Run via
`npm create` / `pnpm create` / `yarn create` / `bun create`.

> Status: alpha (`0.0.1-alpha.9`).

## Usage

```bash
npm create arkor@latest my-app
# or:
pnpm create arkor my-app
yarn create arkor my-app
bun create arkor my-app
```

With no positional, you'll be prompted for a project name and a fresh
subdirectory of that name will be created in the current directory. Pass `.`
to scaffold into the current directory instead:

```bash
npm create arkor@latest          # → ./<prompted-name>/
npm create arkor@latest my-app   # → ./my-app/
npm create arkor@latest .        # → scaffold here
```

Interactive by default. Pass flags to skip prompts:

```bash
pnpm create arkor my-app \
  --template triage \
  --use-pnpm \
  --skip-install \
  --skip-git
```

## Flags

| Flag | Effect |
|---|---|
| `[dir]` (positional) | Target directory. If omitted, a new subdirectory named after the project is created. Pass `.` to scaffold into the current directory |
| `--name <name>` | Project name (sanitised for `package.json`). When `[dir]` is omitted, also used as the new subdirectory name |
| `--template <id>` | `triage` / `translate` / `redaction` |
| `-y`, `--yes` | Accept defaults instead of prompting |
| `--skip-install` | Don't run `<pm> install` after scaffolding |
| `--use-npm` / `--use-pnpm` / `--use-yarn` / `--use-bun` | Force a package manager (otherwise auto-detected from `npm_config_user_agent`) |
| `--git` / `--skip-git` | Initialise a git repo with an initial commit, or skip the prompt |
| `--allow-builds` | Opt esbuild's `postinstall` script into running on `pnpm install` (pnpm-only; default: deny). See [Postinstall scripts (pnpm 11+)](#postinstall-scripts-pnpm-11) below |

## What it writes

```
my-app/
├── src/arkor/
│   ├── index.ts        # createArkor({ trainer }) entry point
│   └── trainer.ts      # template-specific createTrainer({...})
├── arkor.config.ts
├── README.md
├── .gitignore          # node_modules/, dist/, .arkor/
├── package.json        # scripts: dev / build / start
└── pnpm-workspace.yaml # pnpm 11 allowBuilds (yarn/npm/bun ignore it)
```

`pnpm-workspace.yaml` is only emitted for fresh scaffolds where pnpm is plausibly the chosen package manager (`--use-pnpm` or no `--use-*` flag), and only when no ancestor directory already declares one. If you scaffold inside an existing pnpm monorepo, the parent's workspace file governs and we do not write a nested one.

## Postinstall scripts (pnpm 11+)

pnpm 11 errors with `ERR_PNPM_IGNORED_BUILDS` when an unapproved postinstall is encountered. esbuild ships such a script (verifying/fetching the platform-specific binary), so a vanilla `pnpm install` against a fresh scaffold would otherwise exit non-zero.

The scaffolded `pnpm-workspace.yaml` pins:

```yaml
packages: []
allowBuilds:
  esbuild: false
```

`esbuild: false` is an explicit deny — pnpm sees a decision and silently skips the script instead of erroring. esbuild itself still works because pnpm already installs `@esbuild/<platform>` as an `optionalDependency`. Pass `--allow-builds` to flip the entry to `true` if you genuinely need the postinstall (rare; typically a broken installer or unusual platform). yarn / npm / bun all ignore the workspace yaml.

When `[dir]` is given explicitly, existing files are kept (never overwritten)
and `package.json` is patched in place — only missing keys are added, so a
hand-edited `build: "tsc"` survives. When the target directory is auto-derived
(no `[dir]` passed), an existing non-empty `./<project-name>/` is treated as a
collision: interactive runs re-prompt for a different name, and `-y` /
non-interactive runs exit with an error.

## Templates

- **triage** — support ticket triage. Free-text in → `{category, urgency, summary, nextAction}` JSON. Dataset: `arkorlab/triage-demo`. ~7 min training.
- **translate** — multilingual support-intake translation across 9 languages. → `{translation, detectedLanguage}` JSON. Dataset: `arkorlab/translate-demo`. ~7 min training.
- **redaction** — PII redaction. Free-text in → `{redactedText, redactedCount, tags}` JSON with `[REDACTED]` substitutions. Dataset: `arkorlab/redaction-demo`. ~12 min training.

All three pair `unsloth/gemma-4-E4B-it` with a public dataset hosted under [`arkorlab` on HuggingFace](https://huggingface.co/arkorlab). The `src/arkor/index.ts` entry point is identical across templates; only `src/arkor/trainer.ts` differs.

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

## License

MIT — see [LICENSE.md](./LICENSE.md).
