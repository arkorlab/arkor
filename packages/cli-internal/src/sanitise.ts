/**
 * Normalise a candidate project name into a safe lowercase slug:
 *   - lowercased
 *   - non `[a-z0-9-]` characters replaced with `-`
 *   - consecutive dashes collapsed to a single `-`
 *   - leading / trailing `-` trimmed
 *   - capped at 60 characters
 *   - falls back to `"arkor-project"` if the result is empty
 */
export function sanitise(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "-")
      .replaceAll(/-+/g, "-")
      // Split into two passes instead of `/^-+|-+$/g`: the alternation
      // with two greedy `-+` branches is a CodeQL polynomial-ReDoS
      // shape on strings made entirely of `-`. After the collapse
      // above the input has at most a single leading / trailing run,
      // and anchored regexes only match once, so `replace` (not
      // `replaceAll`, which requires the `g` flag) is the right shape.
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 60) || "arkor-project"
  );
}
