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
├── .yarnrc.yml         # OPTIONAL — yarn-berry nodeLinker pin (see below)
└── pnpm-workspace.yaml # OPTIONAL — pnpm 11 allowBuilds (see below)
```

`src/arkor/`, `arkor.config.ts`, `README.md`, `.gitignore`, and `package.json` are always written. The two yaml files are conditional:

- **`.yarnrc.yml`** is *created* with `nodeLinker: node-modules` only on **fresh scaffolds** where yarn is the plausible package manager — i.e. `--use-yarn` is set, OR no `--use-<pm>` flag is set AND `npm_config_user_agent` failed to identify the invoking pm (so a yarn-berry user reading the manual-install hint and running `yarn install` doesn't hit the PnP default; the arkor runtime can't resolve modules through PnP). When `--use-yarn` runs against an **existing** non-empty directory and no `.yarnrc.yml` is present, the scaffolder deliberately does **not** drop one in (writing `nodeLinker: node-modules` at the root of an unfamiliar project could flip install mode for an enclosing yarn-berry workspace deliberately on PnP) — instead it surfaces a yarn-berry caveat advisory. An existing `.yarnrc.yml` is left untouched: already-`node-modules` is a no-op, a non-default `nodeLinker:` produces a conflict warning, and a missing `nodeLinker:` key surfaces the same berry caveat. Skipped entirely for explicit non-yarn pms (including the common `npm create arkor` flow, where UA detection lands on npm).
- **`pnpm-workspace.yaml`** is created when pnpm is the plausible package manager (`--use-pnpm`, or pm-detection failed AND the target is a fresh empty directory) AND no ancestor directory already declares one. When a target already has the file and pnpm is plausible, it is *patched* in place: `esbuild: false` is merged into the existing top-level `allowBuilds:` (other keys, comments, and entries are preserved). Skipped for `--use-npm` / `--use-yarn` / `--use-bun` (and likewise the `npm create` / `yarn create` / `bun create` flows that resolve via UA) and inside pnpm monorepo subdirs (the parent's workspace file governs — we never shadow it).

## Postinstall scripts (pnpm 11+)

pnpm 11 errors with `ERR_PNPM_IGNORED_BUILDS` when an unapproved postinstall is encountered. esbuild ships such a script (verifying/fetching the platform-specific binary), so a vanilla `pnpm install` against a fresh scaffold would otherwise exit non-zero.

The scaffolded `pnpm-workspace.yaml` pins:

```yaml
packages: []
allowBuilds:
  esbuild: false
```

`esbuild: false` is an explicit deny — pnpm sees a decision and silently skips the script instead of erroring. esbuild itself still works because pnpm already installs `@esbuild/<platform>` as an `optionalDependency`. yarn / npm / bun all ignore the workspace yaml.

If you genuinely need the postinstall to run (rare; typically a broken installer or unusual platform), pass `--allow-builds`. The flag controls only the value the scaffold *writes*: a fresh-scaffold run emits `esbuild: true` instead of `esbuild: false`, and a patch-into-existing-file run that adds a new `esbuild` entry uses `true`. An *existing* explicit pin is always preserved — if the file already has `allowBuilds.esbuild: false` (or `: true`), the scaffold leaves it untouched even when `--allow-builds` is passed. To change a prior explicit deny, edit `pnpm-workspace.yaml` by hand.

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
