import { Header } from "./Header";

import type { Credentials } from "../../lib/api";
import type { Route } from "../../route";
import type { ReactNode } from "react";

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
    <div className="bg-canvas text-fg min-h-full">
      <Header creds={creds} error={error} route={route} />
      <main className="mx-auto w-full max-w-[1200px] px-6 py-8">
        {children}
      </main>
    </div>
  );
}
