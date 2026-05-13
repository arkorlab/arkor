import { useEffect, useReducer } from "react";
import { formatRelativeTime } from "../../lib/format";

// Each `RelativeTime` instance used to own a `setInterval(... 30_000)`
// of its own. With dozens of jobs in a table that scaled to hundreds
// of independent timers all firing on slightly different schedules.
// Replace it with one module-level interval that ticks all subscribed
// instances in lockstep, started lazily on the first subscription and
// torn down when the last subscriber unmounts.
const subscribers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (ticker === undefined) {
    ticker = setInterval(() => {
      for (const f of subscribers) f();
    }, 30_000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

// Vite HMR replaces the module without unloading the previous one's
// closures, so without an explicit dispose the old `setInterval` keeps
// firing in dev and every hot reload doubles the tick rate. Production
// bundles strip `import.meta.hot`, so this is a no-op there.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    subscribers.clear();
  });
}

export function RelativeTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribe(force), []);
  return (
    <time className={className} dateTime={iso} title={iso}>
      {formatRelativeTime(iso)}
    </time>
  );
}
