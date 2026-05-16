/**
 * Normalise a candidate project name into a safe lowercase slug:
 *   - lowercased
 *   - non-alphanumeric runs (including existing `-`) collapsed to a single `-`
 *   - capped at 60 characters
 *   - a single leading / trailing `-` trimmed (after the cap)
 *   - falls back to `"arkor-project"` if the result is empty
 *
 * The original chain was three separate replaces (`/[^a-z0-9-]/g`,
 * `/-+/g`, `/^-+|-+$/g`), each a linear character-class or literal
 * scan. CodeQL's "polynomial-regex on uncontrolled data" query
 * conservatively flagged the chain even though no pattern actually
 * backtracks; what the query keys off is the *combination* of
 * `+`-quantified regexes running over the same CLI-arg input from
 * `arkor init` / `create-arkor` (on `--name`, `[dir]` basenames, and
 * prompt values), where a pathological all-`-` input is consumed by
 * the literal-keeping `/[^a-z0-9-]/g` and then re-scanned by the
 * collapsing `/-+/g`. A single `+`-quantified replace on its own is
 * not flagged (the rewrite below still uses `/[^a-z0-9]+/g` and
 * passes the query). Rather than annotate a suppression, the chain
 * was rewritten into one negated-class collapse plus an anchored
 * trim: a run of any non-alphanumeric characters becomes one `-` in a
 * single linear pass (`-` is inside the negated class now, so the
 * separate run-collapse step is gone), which removes the chained-pass
 * shape the query flagged.
 *
 * Trim runs *after* `.slice(0, 60)` so an alphanumeric-then-separator
 * input that gets cut on the separator (e.g. 59 letters + `_b` after
 * the run-collapse becomes `aaa…a-b`, then sliced to `aaa…a-`)
 * doesn't leak a trailing dash into the final slug. The 60-char cap
 * is a budget and the trim is the contract; doing them in this order
 * makes the contract win.
 */
export function sanitise(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60)
      .replace(/^-|-$/g, "") || "arkor-project"
  );
}
