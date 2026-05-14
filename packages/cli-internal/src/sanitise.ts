/**
 * Normalise a candidate project name into a safe lowercase slug:
 *   - lowercased
 *   - non-alphanumeric runs (including existing `-`) collapsed to a single `-`
 *   - a single leading / trailing `-` trimmed
 *   - capped at 60 characters
 *   - falls back to `"arkor-project"` if the result is empty
 *
 * The regexes are deliberately written so each input character is
 * consumed at most a constant number of times, avoiding the
 * polynomial-backtracking shape CodeQL flagged when the previous
 * chain combined `/[^a-z0-9-]/g` (which kept `-` as a literal) with a
 * separate `/-+/g` collapse: an adversarial input of many `-` runs
 * walked the same characters across two `+`-quantified passes. The
 * new first regex includes `-` in the negated class so a single linear
 * scan does both substitution and run-collapsing; the trim step then
 * only ever has to strip a single dash at each anchor because runs
 * have already been collapsed.
 */
export function sanitise(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "arkor-project"
  );
}
