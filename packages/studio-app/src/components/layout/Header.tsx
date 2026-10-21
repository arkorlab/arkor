import { ArkorMark } from "../icons/ArkorMark";

import { IdentityChip } from "./IdentityChip";
import { NavTabs } from "./NavTabs";
import { ThemeToggle } from "./ThemeToggle";

import type { Credentials } from "../../lib/api";
import type { Route } from "../../route";

export function Header({
  creds,
  error,
  route,
}: {
  creds: Credentials | null;
  error: string | null;
  route: Route;
}) {
  // `bg-surface/80` is the one intended opacity modifier in the app:
  // backdrop-blur needs a translucent surface for content to show through as
  // it scrolls underneath.
  return (
    <header className="border-edge bg-surface/80 sticky top-0 z-30 border-b backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center gap-3 px-6">
        <a href="#/" className="text-fg flex shrink-0 items-center gap-2">
          <ArkorMark />
          <span className="text-[15px] font-semibold tracking-tight">
            Arkor
          </span>
        </a>

        <span aria-hidden className="text-edge-strong">
          /
        </span>

        <span className="text-fg text-sm font-medium">Studio</span>

        <div className="ml-auto flex items-center gap-3">
          <IdentityChip creds={creds} error={error} />
          <ThemeToggle />
        </div>
      </div>

      <div className="mx-auto flex h-10 w-full max-w-[1200px] items-end px-6">
        <NavTabs route={route} />
      </div>
    </header>
  );
}
