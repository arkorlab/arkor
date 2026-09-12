import { cn } from "../ui/cn";

import type { Route } from "../../route";

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
  {
    label: "Endpoints",
    href: "#/endpoints",
    match: (r) => r.kind === "endpoints" || r.kind === "endpoint",
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
                  active ? "text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                <span
                  className={cn(
                    "rounded-md px-2 py-1.5",
                    !active && "hover:bg-inset",
                  )}
                >
                  {tab.label}
                </span>
                {active ? (
                  <span
                    aria-hidden
                    className="bg-fg absolute inset-x-2 -bottom-px h-0.5 rounded-full"
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
