import * as React from "react";
import Link from "next/link";

import { cn } from "../lib/utils.ts";

export type NavItem = { href: string; label: string };

export type AppShellProps = {
  title: string;
  subtitle?: string;
  nav: NavItem[];
  /** Current path for active nav highlighting */
  pathname?: string;
  children: React.ReactNode;
  className?: string;
};

/** Shared chrome for control-plane and agent pane apps. */
export function AppShell({ title, subtitle, nav, pathname, children, className }: AppShellProps) {
  return (
    <div className={cn("min-h-screen bg-background", className)}>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          <nav className="flex flex-wrap gap-1">
            {nav.map((item) => {
              const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
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
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
