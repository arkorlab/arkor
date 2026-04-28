# Contributing to Arkor

Thanks for your interest! Arkor is in **alpha**: we're moving fast, breaking things on purpose, and the core idea (TypeScript-native fine-tuning for product engineers) is something we want to design *with* the people who'd use it. Issues, discussion, and PRs are all welcome.

## Ways to help

| Effort                  | What's most useful                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------- |
| **5 min**               | Try the [Quickstart](README.md#quickstart) and [open an issue](https://github.com/arkorlab/arkor/issues/new) about anything that confused you, broke, or felt un-TypeScript. |
| **An afternoon**        | Pick up a [`good first issue`](https://github.com/arkorlab/arkor/labels/good%20first%20issue) or send a small PR (doc fixes, template tweaks, error-message polish). |
| **Ongoing**             | Hop into [Discord](https://discord.gg/YujCZYGrEZ) and tell us what model + dataset + workflow you wish worked. We use this to prioritize. |

If you have an idea for a non-trivial change (new SDK factory, CLI command, Studio view), please open an issue first so we can align on the API shape before you write code.

## Repo layout

```
arkor/
├── packages/
│   ├── arkor/              # SDK + CLI + bundled local Studio (published to npm)
│   ├── create-arkor/       # `pnpm create arkor` scaffolder (published to npm)
│   ├── cli-internal/       # private helpers shared by arkor + create-arkor
│   └── studio-app/         # Vite + React SPA bundled into `arkor`
├── e2e/cli/                # vitest-driven E2E suite for the scaffolder & build
├── assets/                 # README / OG images
└── turbo.json              # build / test orchestration
```

`cli-internal`, `studio-app`, and `e2e/cli` are private and never published.

## Development setup

Please use **Node.js 24 (Preferably the latest) ** and **pnpm 10.21+**.

```bash
git clone https://github.com/arkorlab/arkor.git
cd arkor
pnpm install
pnpm build         # turbo run build (covers all packages)
pnpm test          # unit tests across the monorepo
pnpm typecheck     # tsc across the monorepo
```

To work on a specific package:

```bash
pnpm --filter arkor dev          # tsdown --watch on the SDK/CLI
pnpm --filter @arkor/studio-app dev   # vite dev server for the Studio SPA
pnpm --filter create-arkor dev   # tsdown --watch on the scaffolder
```

To run the E2E scaffolder/build suite (slow; spawns real CLIs in temp dirs):

```bash
pnpm --filter @arkor/e2e-cli test
# Skip the `<pm> install` step inside fixtures:
SKIP_E2E_INSTALL=1 pnpm --filter @arkor/e2e-cli test
```

## Trying your local build

The fastest loop is to scaffold a fresh project pointing at the workspace build:

```bash
pnpm build
cd /tmp && node /path/to/arkor/packages/create-arkor/dist/bin.mjs my-arkor-app
cd my-arkor-app && pnpm dev
```

Studio runs at `http://127.0.0.1:4000` with a CSRF token injected per launch.

## Pull request guidelines

- **One concern per PR.** Smaller diffs land faster.
- **Tests where the surface is testable.** SDK / CLI / scaffolder logic should have a vitest case. Studio UI changes can be PR'd with a screenshot or short clip.
- **Breaking changes are fine** during alpha. We don't ship compatibility shims between `0.0.x` versions, so just note them in the PR description and the changelog stays honest.
- **Don't reintroduce removed verbs.** `arkor train`, `arkor deploy`, `arkor jobs`, and `arkor logs` were removed deliberately. Training and deploying are TS configs that run when the entrypoint executes, not CLI verbs. The CLI surface is `dev` / `build` / `start` plus auth.

## Reporting bugs and security issues

- **Bugs**: [GitHub Issues](https://github.com/arkorlab/arkor/issues/new) with steps to reproduce, expected vs actual, and your Node + pnpm versions.
- **Security**: please email security@arkor.ai instead of filing a public issue. We'll acknowledge within 48 hours.

## Code of conduct

Be kind, assume good faith, and keep technical disagreement technical. Anything else (harassment, personal attacks, exclusionary behavior) is grounds for being asked to leave. The maintainers' call is final.

## License

By contributing, you agree your contributions are licensed under the [MIT license](LICENSE.md).
