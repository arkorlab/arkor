import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-edge inline-block rounded-md motion-safe:animate-pulse",
        className,
      )}
    />
  );
}
