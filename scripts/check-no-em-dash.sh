#!/usr/bin/env bash
# Guard against em-dash regressions across the tracked tree.
#
# Scope: every tracked file in the repository. The ESLint rule
# `local/no-em-dash` already enforces the same policy on TS / TSX / JS /
# JSX / MTS / MJS sources under `packages/*` and `e2e/*`, so this script
# overlaps with it on those files; that overlap is the point. The value
# of running it on the whole tree (yaml, md, json, html, root config,
# AND the linted source) is being a single check that succeeds iff the
# repo is clean end-to-end, so a future weakening of the rule's include
# globs cannot silently let an em dash slip in. Run from the repo root,
# in CI and locally via `pnpm check:no-em-dash`.
#
# Pattern: the em-dash glyph U+2014 and its HTML entity. The glyph is
# built at runtime from its UTF-8 byte sequence via bash ANSI-C quoting
# (`$'\xe2\x80\x94'`) and the entity from string concatenation, so
# this script file itself contains neither literal. We deliberately
# avoid `git grep -P` so the script does not depend on Git being built
# with PCRE2 support (which is not guaranteed on minimal Git
# installations and would otherwise fail the script even on a clean
# tree).

set -euo pipefail

em_dash=$'\xe2\x80\x94'
entity='&'"mdash;"

if git grep -n -e "$em_dash" -e "$entity" -- ':!scripts/check-no-em-dash.sh'; then
  {
    printf '\n[check:no-em-dash] em-dash glyph or HTML entity found above.\n'
    printf '[check:no-em-dash] Project policy: use a colon, period, comma, parentheses, " - ", or restructure.\n'
    printf '[check:no-em-dash] See CONTRIBUTING.md > Style conventions.\n'
  } >&2
  exit 1
fi

printf '[check:no-em-dash] OK: no em dashes in the tracked tree.\n'
