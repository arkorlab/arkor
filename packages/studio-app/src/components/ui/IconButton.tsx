import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Size = "sm" | "md";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  label: string;
}

const SIZE: Record<Size, string> = {
  sm: "h-7 w-7",
  md: "h-9 w-9",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = "md", className, children, label, type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center rounded-lg text-zinc-600 transition-colors",
        "hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  ),
);
IconButton.displayName = "IconButton";
