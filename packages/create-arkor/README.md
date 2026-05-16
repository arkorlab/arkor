# create-arkor

Scaffolder for [Arkor](https://github.com/arkorlab/arkor) projects. Run via
`npm create` / `pnpm create` / `yarn create` / `bun create`.

> Status: alpha (`0.0.2-alpha.2`).

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
| `--agents-md` / `--no-agents-md` | Write `AGENTS.md` + `CLAUDE.md` to brief AI coding agents that arkor post-dates their training data (default: on) |

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
├── AGENTS.md           # AI-agent rules (omit with --no-agents-md)
├── CLAUDE.md           # @AGENTS.md re-export for Claude Code
├── .yarnrc.yml         # OPTIONAL — yarn-berry nodeLinker pin (see below)
└── pnpm-workspace.yaml # OPTIONAL — pnpm 11 allowBuilds (see below)
```

`src/arkor/`, `arkor.config.ts`, `README.md`, `.gitignore`, and `package.json` are always written. The two yaml files are conditional:

- **`.yarnrc.yml`** is *created* with `nodeLinker: node-modules` only on **fresh scaffolds** where yarn is the plausible package manager (i.e. `--use-yarn` is set, `npm_config_user_agent` resolves to yarn (e.g. `yarn create arkor`), OR no `--use-*` flag is set AND UA detection failed to identify the invoking pm). This protects yarn-berry users reading the manual-install hint who then run `yarn install`: without the pin, yarn-berry defaults to PnP and the arkor runtime can't resolve modules through PnP. When `--use-yarn` runs against an **existing** non-empty directory and no `.yarnrc.yml` is present, the scaffolder deliberately does **not** drop one in (writing `nodeLinker: node-modules` at the root of an unfamiliar project could flip install mode for an enclosing yarn-berry workspace deliberately on PnP). Whether it then surfaces a yarn-berry caveat advisory depends on whether a positive yarn-berry signal is detected: an ancestor `.yarnrc.yml` or `.yarn/` directory, a corepack `packageManager: yarn@2+` field declared anywhere up the tree, or `yarn --version` reporting yarn 2+. Yarn-classic users see no caveat (PnP isn't a yarn 1 concern, so there's nothing to nudge them about). An existing `.yarnrc.yml` is left untouched: already-`node-modules` is a no-op, a non-default `nodeLinker:` produces a conflict warning, and a missing `nodeLinker:` key surfaces the same berry caveat (the file's existence is itself a yarn-berry signal, since yarn 1 reads `.yarnrc`, not `.yarnrc.yml`). Skipped entirely for explicit non-yarn pms (including the common `npm create arkor` flow, where UA detection lands on npm).
- **`pnpm-workspace.yaml`** is created when pnpm is the plausible package manager (`--use-pnpm`, `npm_config_user_agent` resolves to pnpm (e.g. `pnpm create arkor`), or pm-detection failed AND the target is a fresh empty directory) AND no ancestor directory already declares one. When a target already has the file and pnpm is plausible, it is *patched* in place: `esbuild: false` is merged into the existing top-level `allowBuilds:` (other keys, comments, and entries are preserved). Skipped for `--use-npm` / `--use-yarn` / `--use-bun` (and likewise the `npm create` / `yarn create` / `bun create` flows that resolve via UA) and inside pnpm monorepo subdirs (the parent's workspace file governs; we never shadow it).

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

`AGENTS.md` is patched non-destructively: an existing user file is preserved
and the arkor-managed block is appended or, on re-scaffold, replaced in place.
The block is identified by **three** signals together — the BEGIN marker
(`<!-- BEGIN:arkor-agent-rules -->`), the END marker
(`<!-- END:arkor-agent-rules -->`), and the canonical first content line
(`# arkor is newer than your training data`) — all on their own lines. If you
hand-edit that heading, the matcher no longer recognises the block as managed
and treats it as ordinary user content; a re-scaffold then appends a fresh
canonical block alongside the edited one without any warning. The ambiguous-
block warning fires only when **multiple signature-matching blocks** are
present at once — typically from pasting the canonical block twice, not from
heading edits — in which case the scaffolder refuses to guess which copy is
current, leaves the file untouched, and asks you to dedupe before the next
re-scaffold patches in place.
`CLAUDE.md` is created with `@AGENTS.md` only when it does not already
exist *and* `AGENTS.md` does not contain duplicate managed blocks. In
the duplicate-block case the scaffolder skips `CLAUDE.md` too, since it
would otherwise auto-import the unresolved rules into Claude Code via
the `@<path>` directive — the next re-scaffold creates the file once
`AGENTS.md` is deduped.

Claude Code auto-loads `CLAUDE.md` from the project root, and the
`@<path>` directive is a built-in import — writing `@AGENTS.md` inlines
the AGENTS.md contents into Claude's context, so the two files stay in
sync without duplication. Other agents that follow the AGENTS.md
convention read `AGENTS.md` directly.

## Templates

- **triage** — support ticket triage. Free-text in → `{category, urgency, summary, nextAction}` JSON. Dataset: `arkorlab/triage-demo`. ~7 min training.
- **translate** — multilingual support-intake translation across 9 languages. → `{translation, detectedLanguage}` JSON. Dataset: `arkorlab/translate-demo`. ~7 min training.
- **redaction** — PII redaction. Free-text in → `{redactedText, redactedCount, tags}` JSON with `[REDACTED]` substitutions. Dataset: `arkorlab/redaction-demo`. ~12 min training.

All three pair `gemma-4-E4B-it` with a public dataset hosted under [`arkorlab` on HuggingFace](https://huggingface.co/arkorlab). The `src/arkor/index.ts` entry point is identical across templates; only `src/arkor/trainer.ts` differs.

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
