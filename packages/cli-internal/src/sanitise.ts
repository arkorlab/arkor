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
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "arkor-project"
  );
}
