import type { ReactNode } from "react";
import type { Credentials } from "../../lib/api";
import type { Route } from "../../route";
import { Header } from "./Header";

export function AppShell({
  creds,
  error,
  route,
  children,
}: {
  creds: Credentials | null;
  error: string | null;
  route: Route;
  children: ReactNode;
}) {
  return (
    <div className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Header creds={creds} error={error} route={route} />
      <main className="mx-auto w-full max-w-[1200px] px-6 py-8">{children}</main>
    </div>
  );
}
