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
  (
    { size = "md", className, children, label, type = "button", ...rest },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "text-fg-muted inline-flex items-center justify-center rounded-lg transition-colors",
        "hover:bg-inset hover:text-fg",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
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
