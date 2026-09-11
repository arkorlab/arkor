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
      // No colour for the copied state: a success green would be the only one
      // in the app, and a neutral override could not win anyway. `cn` joins
      // without resolving conflicts, so between two same-property utilities
      // the winner is whichever Tailwind emits later, and `text-fg-muted`
      // (IconButton's own) is emitted after `text-fg`. The icon swap is the
      // signal.
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  );
}
