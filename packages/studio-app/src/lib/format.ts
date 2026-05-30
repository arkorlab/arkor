// Shared "no value" placeholder for table cells and metadata fields where
// the value is missing, unparseable, or doesn't apply yet (a job that
// hasn't started, a config field the trainer didn't set, a duration
// that can't be computed because the backend dropped `completedAt`).
//
// We chose the literal string `"N/A"` over the typographic em / en dash
// after the ENG-764 em-dash cleanup forced us to revisit the
// placeholder anyway:
//   - The em dash (U+2014) is banned project-wide and can't come back.
//   - An en dash (U+2013) reads as continuous with the column on
//     visual scan but is acoustically empty for screen readers (most
//     just skip it or say "dash"), and on numeric columns it can be
//     mistaken for a stray minus sign or hyphen.
//   - ASCII `-` has the same accessibility problem and looks like
//     part of the value (especially next to negative numbers).
//   - `"N/A"` is unambiguous to both sighted and screen-reader users
//     and ASCII-only (no Unicode special character).
//
// The tradeoff is width: `"N/A"` is three characters where the dashes
// were one, so in a very narrow column (the Duration column in the
// Jobs list is the tightest one in the Studio today) it can widen the
// cell or push the tabular-nums alignment of the populated rows by a
// few pixels. We accepted that cost because the clarity win is on the
// rarer "no value" path and the populated rows still dominate the
// column's natural width. If we ever introduce a column tight enough
// that the three-character placeholder genuinely hurts the populated
// rows, the right move is to revisit the placeholder at the call site
// (a per-column override imported from this constant), not to widen
// the shared default back toward a single-character glyph.
export const NO_VALUE_PLACEHOLDER = "N/A";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return NO_VALUE_PLACEHOLDER;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

const RTF =
  typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
    ? new Intl.RelativeTimeFormat("en", { numeric: "auto" })
    : null;

// Phrase the manual fallback explicitly so older runtimes without
// `Intl.RelativeTimeFormat` still produce human-readable output instead
// of leaking the raw signed delta (e.g. "-5m" for a past timestamp).
function fallbackRelative(value: number, unit: string): string {
  const abs = Math.abs(value);
  return value < 0 ? `${abs}${unit} ago` : `in ${abs}${unit}`;
}

export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return NO_VALUE_PLACEHOLDER;
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) {
    return RTF ? RTF.format(diffSec, "second") : fallbackRelative(diffSec, "s");
  }
  if (abs < 60 * 45) {
    const v = Math.round(diffSec / 60);
    return RTF ? RTF.format(v, "minute") : fallbackRelative(v, "m");
  }
  if (abs < 3600 * 22) {
    const v = Math.round(diffSec / 3600);
    return RTF ? RTF.format(v, "hour") : fallbackRelative(v, "h");
  }
  if (abs < 86_400 * 26) {
    const v = Math.round(diffSec / 86_400);
    return RTF ? RTF.format(v, "day") : fallbackRelative(v, "d");
  }
  if (abs < 86_400 * 320) {
    const v = Math.round(diffSec / (86_400 * 30));
    return RTF ? RTF.format(v, "month") : fallbackRelative(v, "mo");
  }
  const v = Math.round(diffSec / (86_400 * 365));
  return RTF ? RTF.format(v, "year") : fallbackRelative(v, "y");
}

export function truncateMiddle(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
