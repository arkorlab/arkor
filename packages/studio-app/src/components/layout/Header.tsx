import type { Credentials } from "../../lib/api";
import type { Route } from "../../route";
import { ArkorMark } from "../icons/ArkorMark";
import { IdentityChip } from "./IdentityChip";
import { NavTabs } from "./NavTabs";
import { ThemeToggle } from "./ThemeToggle";

export function Header({
  creds,
  error,
  route,
}: {
  creds: Credentials | null;
  error: string | null;
  route: Route;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center gap-3 px-6">
        <a
          href="#/"
          className="flex shrink-0 items-center gap-2 text-zinc-900 dark:text-zinc-100"
        >
          <ArkorMark />
          <span className="text-[15px] font-semibold tracking-tight">Arkor</span>
        </a>

        <span aria-hidden className="text-zinc-300 dark:text-zinc-700">
          /
        </span>

        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Studio
        </span>

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
