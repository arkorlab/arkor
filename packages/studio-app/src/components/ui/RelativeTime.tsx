import { useEffect, useState } from "react";
import { formatRelativeTime } from "../../lib/format";

export function RelativeTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className={className} dateTime={iso} title={iso}>
      {formatRelativeTime(iso)}
    </time>
  );
}
