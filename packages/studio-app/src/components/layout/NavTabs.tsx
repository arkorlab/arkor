import type { Route } from "../../route";
import { cn } from "../ui/cn";

interface NavTab {
  label: string;
  href: string;
  match: (route: Route) => boolean;
}

const TABS: NavTab[] = [
  {
    label: "Overview",
    href: "#/",
    match: (r) => r.kind === "home",
  },
  {
    label: "Jobs",
    href: "#/jobs",
    match: (r) => r.kind === "jobs" || r.kind === "job",
  },
  {
    label: "Playground",
    href: "#/playground",
    match: (r) => r.kind === "playground",
  },
];

export function NavTabs({ route }: { route: Route }) {
  return (
    <nav aria-label="Primary" className="flex h-full items-end">
      <ul className="flex h-full items-end gap-1">
        {TABS.map((tab) => {
          const active = tab.match(route);
          return (
            <li key={tab.href} className="flex h-full items-stretch">
              <a
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative inline-flex items-center px-3 text-sm font-medium transition-colors",
                  active
                    ? "text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                )}
              >
                <span
                  className={cn(
                    "rounded-md px-2 py-1.5",
                    !active && "hover:bg-zinc-100 dark:hover:bg-zinc-900",
                  )}
                >
                  {tab.label}
                </span>
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-teal-500"
                  />
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
