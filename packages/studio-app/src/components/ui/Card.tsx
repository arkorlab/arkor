import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function Card({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-zinc-200 bg-white",
        "dark:border-zinc-800 dark:bg-zinc-950",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  className,
  children,
  actions,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { actions?: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 px-6 py-5",
        "border-b border-zinc-200 dark:border-zinc-800",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        "text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100",
        className,
      )}
      {...rest}
    >
      {children}
    </h2>
  );
}

export function CardDescription({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "mt-1 text-sm text-zinc-500 dark:text-zinc-400",
        className,
      )}
      {...rest}
    >
      {children}
    </p>
  );
}

export function CardContent({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-6 py-5", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
