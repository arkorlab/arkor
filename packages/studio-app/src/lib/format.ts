export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
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

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return RTF ? RTF.format(diffSec, "second") : `${diffSec}s`;
  if (abs < 60 * 45) {
    const v = Math.round(diffSec / 60);
    return RTF ? RTF.format(v, "minute") : `${v}m`;
  }
  if (abs < 3600 * 22) {
    const v = Math.round(diffSec / 3600);
    return RTF ? RTF.format(v, "hour") : `${v}h`;
  }
  if (abs < 86400 * 26) {
    const v = Math.round(diffSec / 86400);
    return RTF ? RTF.format(v, "day") : `${v}d`;
  }
  if (abs < 86400 * 320) {
    const v = Math.round(diffSec / (86400 * 30));
    return RTF ? RTF.format(v, "month") : `${v}mo`;
  }
  const v = Math.round(diffSec / (86400 * 365));
  return RTF ? RTF.format(v, "year") : `${v}y`;
}

export function truncateMiddle(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
