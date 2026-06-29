# Arkor best practices

Qodo (Qodo Code Review / Qodo Merge) reads this file and raises extra
suggestions, labelled "Organization best practices", when a PR violates any of
the points below. Keep
each point short, actionable, and specific to this repo (general style is already
covered by oxlint/ESLint/oxfmt).

## Bilingual docs

- English and Japanese docs are paired and must change together in the same PR:
  `README.md` with `README.ja.md`, `CONTRIBUTING.md` with `CONTRIBUTING.ja.md`,
  and `docs/` with `docs/ja/`. Never leave the Japanese side to a follow-up.
- Do not edit generated copies (`packages/*/CONTRIBUTING.md`,
  `packages/arkor/docs/`); edit the source under the repo root.
- Mintlify heading slugs are not GitHub-style. Preserve `/`, `=`, and full-width
  parens in anchor ids; ASCII parens and backticks are stripped. Verify a new
  cross-page anchor against the rendered preview before relying on it.

## Writing style

- No em dashes in prose, docs, comments, or READMEs. The only exception is
  user-facing CLI runtime strings (info/warn/error one-liners).

## Review pitfalls (do not "fix" these)

These are correct as written; AGENTS.md flags them as recurring review-bot
mistakes, so do not suggest "fixing" them.

- Docs CLI CodeGroup: `/cli/*` and `/guides/cli/*` pages (and JA mirrors) show
  unscripted subcommands as a 5-tab `<pm> arkor <subcommand>` CodeGroup. The
  `npm` tab stays `npm arkor init`; do not rewrite it to `npx arkor` or
  `npm exec arkor`. These commands assume `arkor` is already in the project.
- Do not call a HuggingFace model or dataset name "non-existent" based on
  training data alone; templates may reference real models newer than the
  knowledge cutoff. Verify, or hedge ("could not confirm") instead of asserting.

## Studio dev server security (security-critical)

- Every `/api/*` request must be authenticated with the per-launch CSRF token:
  `X-Arkor-Studio-Token` header for `fetch`, `?studioToken=` query only for
  `EventSource`. Comparison must stay `timingSafeEqual`.
- `eventStreamPathPattern` may only list GET stream-only routes. Never add a
  mutation endpoint to it.
- Keep the host-header allow-list (`127.0.0.1`/`localhost`) and do NOT add CORS.
- Token persistence to `~/.arkor/studio-token` may fail (read-only $HOME); a
  failure must warn, not block server start.

## HMR primitives stay private

- `requestEarlyStop()` and `replaceCallbacks()` are dev-only HMR primitives kept
  behind `Symbol.for("arkor.trainer.*")` brands. Do not surface them on the
  public `Trainer` interface.
- The server's stale-bundle path must SIGTERM and let the child run `cancel()`.
  Do not escalate to SIGKILL server-side (it would orphan Cloud-side jobs).
- Do not widen the SIGUSR2 hot-swap path to "always hot-swap"; the `configHash`
  match is what prevents a child running with a stale `JobConfig`.

## Dependencies and supply chain

- Direct third-party deps in workspace `package.json` files use `"<name>":
  "catalog:"` and are versioned once in `pnpm-workspace.yaml`. Do not inline
  literal semver (the two published packages' runtime `dependencies` are the
  documented carve-out).
- Do not run `pnpm add -w <pkg>@<v>` against a catalog entry; bump the catalog
  entry and run `pnpm install`.
- Bundled runtime inputs of `@arkor/studio-app` belong in `dependencies`, not
  `devDependencies`, so `pnpm sbom --prod` keeps them in the release SBOM.
- Respect the supply-chain guards in `pnpm-workspace.yaml`
  (`minimumReleaseAge`, `trustPolicy: no-downgrade`, `blockExoticSubdeps`,
  `allowBuilds`). Do not loosen them without justification.

## Formatting and linting boundaries

- oxfmt owns whitespace, wrapping, quotes, and trailing commas; ESLint
  `import-x/order` owns import order. Do not hand-format or reorder imports.
- Prefer a scoped override in `eslint.config.ts` (with the reason in a comment)
  over inline `// eslint-disable` at each call site.

## Tests and deliverables

- SDK/CLI/Studio logic changes ship with vitest cases under
  `packages/*/src/**/*.test.ts` in the same PR; consider an `e2e/cli` scenario
  for CLI flow changes. Do not defer tests or docs to a later PR.
