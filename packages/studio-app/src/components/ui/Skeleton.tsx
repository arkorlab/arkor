import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70",
        className,
      )}
    />
  );
}
