#!/usr/bin/env node
// Guard against em-dash regressions across the tracked tree.
//
// Scope: every tracked file in the repository. The ESLint rule
// `local/no-em-dash` already enforces the same policy on TS / TSX / JS /
// JSX / MTS / MJS sources under `packages/*` and `e2e/*` (covering
// comments, string/template literals, AND JSX text), so this script
// overlaps with it on those files; that overlap is the point. The
// value of running it on the whole tree (yaml, md, json, html, root
// config, AND the linted source) is being a single check that
// succeeds iff the repo is clean end-to-end, so a future weakening of
// the rule's include globs cannot silently let an em dash slip in.
// Run from the repo root, in CI and locally via `pnpm
// check:no-em-dash`.
//
// Pattern: the em-dash glyph U+2014 and its HTML entity. The glyph is
// built from `String.fromCharCode(0x2014)` and the entity from string
// concatenation, so this script file itself contains neither literal.
//
// Cross-platform note: this is a Node script (not bash) so it runs
// uniformly on every supported OS (no `bash` requirement, no
// executable-bit requirement on checkout, no PCRE2 requirement on the
// host's `git`). The previous bash implementation died on `git grep -P`
// when the host git was built without PCRE2; we now match a literal
// pattern (no regex), which works with every supported git build.
//
// Implementation note: written as `.mts` and executed by Node directly.
// Node 22.18+ (the repo's `engines.node >= 22.22.0` minimum, and the
// default Node on the `ubuntu-latest` runner the `no_em_dash` CI job
// uses) strips type annotations from `.mts` files natively, so no
// build step, no `tsx`, and no `--experimental-strip-types` flag is
// needed. The TypeScript surface here is deliberately minimal (just
// what's useful for catching a future spawnSync shape regression);
// keeping it light keeps the script self-contained.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const EM_DASH: string = String.fromCharCode(0x2014);
const ENTITY: string = "&" + "mdash;";

const result: SpawnSyncReturns<string> = spawnSync(
  "git",
  [
    "grep",
    "-n",
    "-e",
    EM_DASH,
    "-e",
    ENTITY,
    "--",
    ":!scripts/check-no-em-dash.mts",
  ],
  { encoding: "utf-8" },
);

if (result.error) {
  process.stderr.write(
    `[check:no-em-dash] failed to spawn git: ${result.error.message}\n`,
  );
  process.exit(1);
}

// Branch on git grep's documented exit codes explicitly so a real
// failure (status 2 from a malformed pathspec, status 128 from
// running outside a git repo, ...) cannot fall through to a false
// green. 0 means a match was found; 1 means a clean tree; everything
// else is treated as an infrastructure error and propagated.
const rc: number | null = result.status;
if (rc === 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(
    "\n[check:no-em-dash] em-dash glyph or HTML entity found above.\n" +
      '[check:no-em-dash] Project policy: use a colon, period, comma, parentheses, " - ", or restructure.\n' +
      "[check:no-em-dash] See CONTRIBUTING.md > Style conventions.\n",
  );
  process.exit(1);
} else if (rc === 1) {
  process.stdout.write(
    "[check:no-em-dash] OK: no em dashes in the tracked tree.\n",
  );
  process.exit(0);
} else {
  if (result.stderr) process.stderr.write(result.stderr);
  process.stderr.write(
    `[check:no-em-dash] git grep exited with status ${String(rc)} (treated as an error).\n`,
  );
  process.exit(rc ?? 1);
}
