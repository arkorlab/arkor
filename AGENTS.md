# Arkor Development Guide

> **Note:** Claude Code automatically loads this file.

## Repository shape

pnpm + Turbo monorepo. Workspaces are declared in `pnpm-workspace.yaml` (`packages/*`, `e2e/*`, `docs`).

| Path | Role |
| --- | --- |
| [packages/arkor](packages/arkor) | Published `arkor` SDK + CLI + bundled local Studio server (Hono). `bin/arkor` → `dist/bin.mjs`. Library entry → `dist/index.mjs`. |
| [packages/create-arkor](packages/create-arkor) | Published `create-arkor` scaffolder (`pnpm create arkor`). |
| [packages/cli-internal](packages/cli-internal) | **Private** workspace package. Source is bundled into `arkor` and `create-arkor` via tsdown's `deps.alwaysBundle`. Never appears as a runtime dependency on npm. |
| [packages/studio-app](packages/studio-app) | **Private** Vite + React 19 SPA. `pnpm --filter @arkor/studio-app bundle` builds it; `packages/arkor/scripts/copy-studio-assets.mjs` copies `dist/` into `packages/arkor/dist/assets/`. |
| [e2e/cli](e2e/cli) | **Private** vitest suite that spawns the built `dist/bin.mjs` of both CLIs in temp dirs. |
| [docs](docs) | Mintlify sources for [docs.arkor.ai](https://docs.arkor.ai). |

## Common commands

Root scripts fan out via Turbo (which respects `^build` deps in [turbo.json](turbo.json)):

```bash
pnpm install
pnpm build          # turbo run build across all packages
pnpm typecheck      # tsc --noEmit across all packages
pnpm test           # vitest run across all packages (incl. e2e)
pnpm test:coverage  # uploads lcov + junit per package; CI uses this
```

Per-package iteration:

```bash
pnpm --filter arkor dev                # tsdown --watch on the SDK/CLI
pnpm --filter @arkor/studio-app dev    # Vite dev server (5173, proxies /api → :4000)
pnpm --filter create-arkor dev         # tsdown --watch on the scaffolder
pnpm --filter @arkor/e2e-cli test      # E2E (slow; spawns real CLIs)
SKIP_E2E_INSTALL=1 pnpm --filter @arkor/e2e-cli test   # skip `<pm> install` inside fixtures
```

Run a single test file: `pnpm --filter <pkg> exec vitest run path/to/file.test.ts`. Use `vitest run -t "name"` to filter by test name.

Trying a local build end-to-end (the loop CONTRIBUTING.md recommends):

```bash
pnpm build
node packages/create-arkor/dist/bin.mjs my-arkor-app   # in a scratch dir
cd my-arkor-app && pnpm dev                            # Studio at http://127.0.0.1:4000
```

## Architecture notes that span files

### CLI build outputs

[packages/arkor/tsdown.config.ts](packages/arkor/tsdown.config.ts) emits two entries (`bin.mjs`, `index.mjs`). Nothing in `src/index.ts` imports the Studio server, so the **entire Studio server is bundled into `dist/bin.mjs`** rather than into a separate file. When tracing Studio behaviour in a built tarball, look for the bin, not `index.mjs`.

`tsdown` also defines `__SDK_VERSION__`, `__ARKOR_POSTHOG_KEY__`, and `__ARKOR_POSTHOG_HOST__` at build time. The fallback in `core/version.ts` only fires under vitest where the transform doesn't run.

### Self-re-exec for TS strip-types

[packages/arkor/src/bin.ts](packages/arkor/src/bin.ts) re-execs Node with `--experimental-strip-types` if the current invocation lacks built-in TypeScript stripping. User training entries are TypeScript and are imported dynamically by `runTrainer`, so Node ≥22.6 must have stripping available. The CI matrix in [.github/workflows/ci.yaml](.github/workflows/ci.yaml) deliberately spans every minor Node version where strip-types semantics shifted.

### Studio CSRF token (security-critical)

`arkor dev` generates a 32-byte base64url token per launch ([packages/arkor/src/cli/commands/dev.ts](packages/arkor/src/cli/commands/dev.ts)) and:

1. Passes it to `buildStudioApp({ studioToken })`. The Hono server validates every `/api/*` request via `X-Arkor-Studio-Token` header (or `?studioToken=` query for `EventSource`, which can't set headers). Comparison uses `timingSafeEqual`.
2. Persists it to `~/.arkor/studio-token` (mode 0600) so the SPA dev workflow (`pnpm --filter @arkor/studio-app dev`) can read it via the `arkor-studio-token` Vite plugin in [packages/studio-app/vite.config.ts](packages/studio-app/vite.config.ts), which injects `<meta name="arkor-studio-token">` into `index.html` on each request. Persistence failure must NOT block server start (read-only `$HOME` on Docker, etc.): just warn.
3. Cleans up on `exit`/SIGINT/SIGTERM/SIGHUP via `unlinkSync`.

`/api/*` middleware also enforces a host-header allow-list (`127.0.0.1`/`localhost`) for DNS-rebinding defence. **CORS is intentionally NOT configured**: the SPA is same-origin so reflecting `*` would let "simple" cross-origin POSTs reach handlers. The token check rejects those; cross-origin tabs cannot read the SPA's `<meta>`.

The whole point: prevents another browser tab on the same machine from POSTing `/api/train` (which spawns `arkor train` and dynamically imports user TS: RCE-grade).

When touching the Studio server or SPA fetch layer, preserve: token via header for `fetch`, query param for `EventSource`, host-header guard, no CORS, timing-safe compare. The Vite plugin is dev-only (`apply: "serve"`): running it during `vite build` would bake a stale per-launch token into the production `index.html` and shadow the runtime tag, causing every `/api/*` call to 403.

### Project entry-point discovery

The CLI/Studio look at `src/arkor/index.ts` in user projects. Discovery in [packages/arkor/src/core/runner.ts](packages/arkor/src/core/runner.ts) accepts (in order): a named `arkor` export from `createArkor({...})`, a bare `trainer` export, a default export holding either an Arkor manifest or a Trainer, or a `default.trainer` nested shape. `createArkor` returns a frozen, opaque manifest tagged with `_kind: "arkor"`; treat it as a value to hand to tooling, not a programmable client.

`arkor build` ([packages/arkor/src/cli/commands/build.ts](packages/arkor/src/cli/commands/build.ts)) bundles to `.arkor/build/index.mjs` with esbuild; bare specifiers (e.g. `arkor`, anything in `node_modules`) stay external so the artifact resolves the runtime SDK from the project's installed copy.

### E2E suite specifics

[e2e/cli](e2e/cli) has a `pretest` hook that rebuilds `create-arkor` and `arkor` before vitest runs. CI's `rolldownIncompat` matrix entries (Nodes <22.12) bypass this hook because rolldown's native binding doesn't load there: the CI builds the dist on a bootstrap Node 24 and then exercises it on the matrix Node directly (`pnpm exec turbo run test --filter='!@arkor/e2e-cli'` followed by `pnpm --filter @arkor/e2e-cli exec vitest run`).

Tests rely on `ARKOR_INTERNAL_SCAFFOLD_ARKOR_SPEC=file:.../packages/arkor` so the scaffolded fixtures install the workspace `arkor` instead of the npm-published one. Both this var and `SKIP_E2E_INSTALL` are declared in [turbo.json](turbo.json) so they pass through Turbo's hash.

E2E coverage uses `c8` wrapping vitest (NOT vitest's own coverage) so child CLI processes' V8 coverage is captured and remapped through tsdown sourcemaps back to `src/`. `create-arkor`'s tsdown config only emits sourcemaps when `CREATE_ARKOR_BUILD_SOURCEMAP=1` (the published tarball ships without them).

## Implementation deliverables (default expectations)

When implementing anything (new feature, SDK/CLI/Studio behaviour change, schema addition, etc.), include the following in the same change unless the user explicitly says otherwise:

1. **Docs in both languages.** This repo pairs English/Japanese docs: `README.md` ↔ `README.ja.md`, `CONTRIBUTING.md` ↔ `CONTRIBUTING.ja.md`, and `docs/` ↔ `docs/ja/`. If you edit the English side, update the Japanese side in the same PR. Don't leave Japanese docs to be retro-translated later.
2. **Tests.** Add vitest cases under `packages/*/src/**/*.test.ts` for SDK/CLI/scaffold logic changes. For CLI flow changes, consider an `e2e/cli` scenario.

Don't split these into "docs in a follow-up PR" or "tests later": land them in the same PR. Skip only when the user explicitly says to.

## Non-obvious gotchas

- **Don't call a HuggingFace model name "non-existent"** based on training-data alone. Templates reference real models (e.g. `unsloth/gemma-4-E4B-it`) that may post-date Claude's knowledge cutoff. Verify (e.g. `WebFetch`) before flagging in issues or PR comments. If unverifiable, hedge ("could not confirm") rather than asserting absence.
- **Generated files** copied into package dirs are gitignored: `packages/*/CONTRIBUTING.md` (from root), `packages/arkor/docs/` (from root `docs/`). Edit the source under repo root, not the copies.
- **Node version**: published packages declare `engines.node >=22.6`. Use Node 24 (latest preferred) for development per [CONTRIBUTING.md](CONTRIBUTING.md).
- **pnpm policy** ([pnpm-workspace.yaml](pnpm-workspace.yaml)): `minimumReleaseAge: 1440` (24 h) and `trustPolicy: no-downgrade` are intentional supply-chain guards. `allowBuilds` is the explicit allow-list for postinstall scripts (rolldown, unrs-resolver, esbuild).
