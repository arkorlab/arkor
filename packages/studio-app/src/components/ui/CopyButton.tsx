import { useEffect, useRef, useState } from "react";

import { Check, Copy } from "../icons";

import { IconButton } from "./IconButton";

export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
}: {
  value: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function onClick() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort
    }
  }

  return (
    <IconButton
      size={size}
      label={copied ? "Copied" : label}
      onClick={() => void onClick()}
      // No colour for the copied state. A success green would be the app's
      // only one outside danger and warn, and a neutral override cannot win
      // over IconButton's own `text-fg-muted` anyway, for the reason `cn.ts`
      // gives. The icon swap is the signal.
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  );
}
