/**
 * Normalise a candidate project name into a safe lowercase slug:
 *   - lowercased
 *   - non-alphanumeric runs (including existing `-`) collapsed to a single `-`
 *   - capped at 60 characters
 *   - a single leading / trailing `-` trimmed (after the cap)
 *   - falls back to `"arkor-project"` if the result is empty
 *
 * The regexes are deliberately written so each input character is
 * consumed at most a constant number of times, avoiding the
 * polynomial-backtracking shape CodeQL flagged when the previous
 * chain combined `/[^a-z0-9-]/g` (which kept `-` as a literal) with a
 * separate `/-+/g` collapse: an adversarial input of many `-` runs
 * walked the same characters across two `+`-quantified passes. The
 * first regex includes `-` in the negated class so a single linear
 * scan does both substitution and run-collapsing; the trim step then
 * only ever has to strip a single dash at each anchor because runs
 * have already been collapsed.
 *
 * Trim runs *after* `.slice(0, 60)` so an alphanumeric-then-separator
 * input that gets cut on the separator (e.g. 59 letters + `_b` → after
 * the run-collapse `aaa…a-b`, then sliced to `aaa…a-`) doesn't leak a
 * trailing dash into the final slug. The 60-char cap is a budget and
 * the trim is the contract; doing them in this order makes the
 * contract win.
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
