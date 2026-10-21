import { Fragment, type ReactNode } from "react";

import { ChevronRight } from "../icons";

import { cn } from "./cn";

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
  mono?: boolean;
}

export function Breadcrumb({
  items,
  className,
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          const content = (
            <span
              className={cn(
                "truncate",
                item.mono && "font-mono text-[13px]",
                isLast ? "text-fg" : "text-fg-muted",
              )}
            >
              {item.label}
            </span>
          );
          return (
            <Fragment key={i}>
              <li className="flex min-w-0 items-center">
                {!isLast && item.href ? (
                  <a
                    href={item.href}
                    className="text-fg-muted hover:text-fg rounded px-1"
                  >
                    {content}
                  </a>
                ) : (
                  <span className="px-1">{content}</span>
                )}
              </li>
              {!isLast ? (
                <li aria-hidden className="text-edge-strong">
                  <ChevronRight width="14" height="14" />
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
