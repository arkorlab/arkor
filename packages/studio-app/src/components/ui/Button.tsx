import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

// `danger` is an outline rather than a solid fill: a destructive action is
// rarely the primary one on a screen, and a red block competes with the
// primary button for the eye. The red is carried by the border and the label.
const VARIANT: Record<Variant, string> = {
  primary:
    "bg-accent text-on-accent hover:bg-accent-hover disabled:hover:bg-accent",
  secondary:
    "border border-edge-strong bg-surface text-fg hover:bg-inset disabled:hover:bg-surface",
  ghost:
    "text-fg-muted hover:bg-inset hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted",
  danger:
    "border border-danger-edge bg-surface text-danger hover:bg-danger-surface disabled:hover:bg-surface",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 rounded-md px-3 text-[13px] gap-1.5",
  md: "h-10 rounded-lg px-4 text-sm gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      className,
      children,
      leadingIcon,
      trailingIcon,
      type = "button",
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center font-medium",
        "focus-visible:ring-ring transition-colors focus-visible:ring-2 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {leadingIcon ? <span className="shrink-0">{leadingIcon}</span> : null}
      {children}
      {trailingIcon ? <span className="shrink-0">{trailingIcon}</span> : null}
    </button>
  ),
);
Button.displayName = "Button";
