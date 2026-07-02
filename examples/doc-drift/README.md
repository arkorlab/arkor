# Documentation drift check

[日本語](./README.ja.md)

One of the things you can build on an Arkor deployment: a check that catches
**documentation drift**, the moment a pull request changes code in a way that
makes your README (or any other document) stale.

The example is a single zero-dependency TypeScript script. It sends a
documentation file plus a unified diff to an Arkor-hosted Gemma 4 deployment
over the OpenAI-compatible chat-completions API, and gets back a structured
verdict:

```json
{ "drifted": true, "severity": "warning", "explanation": "...", "suggestion": "..." }
```

## The easy way: install the GitHub App

You do not need to run any of this yourself. Install the
[drift-check GitHub App](https://github.com/apps/drift-check) and every pull
request in the selected repositories gets exactly what this example shows
(plus comment/code divergence checks), posted as a review summary. No
workflow files, no secrets, no code.

This example exists to show how such a check works under the hood, and how
little code an Arkor deployment needs.

## Use it as a GitHub workflow

Two files, copied into your repository, turn this into a PR check:

1. Copy [`workflow.yaml`](./workflow.yaml) to `.github/workflows/doc-drift.yaml`.
2. Copy [`src/check.ts`](./src/check.ts) to `scripts/doc-drift-check.ts`.
3. In Settings > Secrets and variables > Actions, set:
   - `ARKOR_BASE_URL` (variable): your deployment URL, e.g.
     `https://your-model.arkor.app/v1`
   - `ARKOR_API_KEY` (secret): only when the deployment uses
     `fixed_api_key` auth
   - `ARKOR_MODEL` (variable, optional): defaults to `gemma-4-31b-it`

Each PR then gets a per-document verdict table in the job summary. The step
fails when drift is detected; add `continue-on-error: true` to keep it
advisory.

## Run it locally

```sh
pnpm install

ARKOR_BASE_URL=https://your-model.arkor.app/v1 \
pnpm --filter @arkor/example-doc-drift check
```

With no arguments the script checks the bundled samples: a fictional CLI
README ([`samples/doc.md`](./samples/doc.md)) against a diff that renames the
documented `--max-retries` flag ([`samples/changes.diff`](./samples/changes.diff)),
so it reports drift and exits 1. Pass your own files as
`node src/check.ts <diff-file> <doc-file...>`.

Requires Node.js 24+ (Node 22.7+ works with `--experimental-strip-types`).
To create a deployment of your own model, see the
[Arkor docs](https://docs.arkor.ai).

## How it works

The whole check is one request. The script asks the model for a strict JSON
verdict using structured outputs (`response_format: json_schema`), so the
response always parses:

- `drifted`: whether this diff makes the document inaccurate
- `severity`: `info`, `warning`, or `error`
- `explanation`: which documented statement the diff contradicts
- `suggestion`: a concrete documentation fix

The prompt is deliberately conservative: only clear inconsistencies that the
diff introduces count, so documentation edits or unrelated changes do not
produce noise. The production-grade version of this idea (diff chunking for
large PRs, comment/code divergence checks, review comments) ships as the
[drift-check GitHub App](https://github.com/apps/drift-check).
