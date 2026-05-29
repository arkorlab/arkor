#!/usr/bin/env bash
# Guard against em-dash regressions across the tracked tree.
#
# Scope: every tracked file in the repository. The ESLint rule
# `local/no-em-dash` already covers .ts / .tsx / .js / .jsx / .mts / .mjs
# source under `packages/*` and `e2e/*`; this script covers the rest
# (yaml, md, json, html, root-level config files). Run from the repo root
# in CI and locally via `pnpm check:no-em-dash`.
#
# Pattern matches the em-dash glyph U+2014 and the corresponding HTML
# entity. This script is excluded from the search because it carries the
# pattern by definition.

set -euo pipefail

pattern='\x{2014}|&mdash;'

if git grep -P -n -e "$pattern" -- ':!scripts/check-no-em-dash.sh'; then
  {
    printf '\n[check:no-em-dash] em-dash glyph or HTML entity found above.\n'
    printf '[check:no-em-dash] Project policy: use a colon, period, comma, parentheses, " - ", or restructure.\n'
    printf '[check:no-em-dash] See CONTRIBUTING.md > Style conventions.\n'
  } >&2
  exit 1
fi

printf '[check:no-em-dash] OK: no em dashes in the tracked tree.\n'
