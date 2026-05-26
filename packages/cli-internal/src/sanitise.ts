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
  const collapsed = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-");
  return trimDashes(collapsed).slice(0, 60) || "arkor-project";
}

// Trim leading / trailing `-` from `s`. Hand-rolled instead of
// `replace(/^-+|-+$/g, "")` (alternation with two greedy `-+` branches
// is the CodeQL polynomial-ReDoS shape) or even `/^-+/` + `/-+$/`
// (CodeQL still flags anchored greedy repetition on uncontrolled
// input). Linear scan from each end is unambiguously O(n).
function trimDashes(s: string): string {
  let start = 0;
  while (start < s.length && s[start] === "-") start++;
  let end = s.length;
  while (end > start && s[end - 1] === "-") end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}
