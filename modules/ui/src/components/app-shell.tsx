import * as React from "react";
import Link from "next/link";

import { cn } from "../lib/utils.ts";

export type NavItem = {
  href: string;
  label: string;
  /** Playwright selector: data-pw value */
  pw?: string;
};

export type AppShellProps = {
  title: string;
  subtitle?: string;
  nav: NavItem[];
  /** Current path for active nav highlighting */
  pathname?: string;
  children: React.ReactNode;
  className?: string;
  /** Root data-pw (e.g. control-shell / agent-shell) */
  pw?: string;
};

/** Shared chrome for control-plane and agent pane apps. */
export function AppShell({
  title,
  subtitle,
  nav,
  pathname,
  children,
  className,
  pw,
}: AppShellProps) {
  return (
    <div className={cn("min-h-screen bg-background", className)} data-pw={pw}>
      <header className="border-b border-border" data-pw="app-header">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight" data-pw="app-title">
              {title}
            </h1>
            {subtitle ? (
              <p className="text-sm text-muted-foreground" data-pw="app-subtitle">
                {subtitle}
              </p>
            ) : null}
          </div>
          <nav className="flex flex-wrap gap-1" data-pw="app-nav">
            {nav.map((item) => {
              const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-pw={
                    item.pw ?? `nav-${item.href.replace(/\//g, "-").replace(/^-/, "") || "home"}`
                  }
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                  )}
                  prefetch
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6" data-pw="app-main">
        {children}
      </main>
    </div>
  );
}
