"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "../lib/utils.ts";
import { Toast } from "./toast.tsx";
import { TooltipProvider, WithTooltip } from "./tooltip.tsx";

export type NavItem = {
  href: string;
  label: string;
  /** Playwright selector: data-pw value */
  pw?: string;
  /** Nav link tooltip */
  tip?: string;
};

export type AppShellProps = {
  title: string;
  subtitle?: string;
  titleTip?: string;
  subtitleTip?: string;
  /** Rendered inline next to the title (e.g. an online/offline badge). */
  titleBadge?: React.ReactNode;
  nav: NavItem[];
  /** Current path for active nav highlighting */
  pathname?: string;
  children: React.ReactNode;
  className?: string;
  /** Root data-pw (e.g. control-shell / host-shell) */
  pw?: string;
};

function matchesRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The single most specific nav href matching `pathname`, or null. A blind per-item prefix
 * check would light up both "/sessions" and "/sessions/new" on `/sessions/new` — comparing
 * every href against the whole set and keeping only the longest match means a shorter
 * sibling href never wins once a more specific one also matches.
 */
function activeNavHref(pathname: string | undefined, nav: NavItem[]): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const item of nav) {
    if (!matchesRoute(pathname, item.href)) continue;
    if (best === null || item.href.length > best.length) best = item.href;
  }
  return best;
}

/** Shared chrome for control-plane and host pane apps. */
export function AppShell({
  title,
  subtitle,
  titleTip,
  subtitleTip,
  titleBadge,
  nav,
  pathname,
  children,
  className,
  pw,
}: AppShellProps) {
  const activeHref = activeNavHref(pathname, nav);
  return (
    <TooltipProvider>
      <div className={cn("min-h-screen bg-background", className)} data-pw={pw}>
        <header className="border-b border-border" data-pw="app-header">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                {titleTip ? (
                  <WithTooltip tip={titleTip}>
                    <h1
                      className="inline-block cursor-help text-lg font-semibold tracking-tight"
                      data-pw="app-title"
                    >
                      {title}
                    </h1>
                  </WithTooltip>
                ) : (
                  <h1 className="text-lg font-semibold tracking-tight" data-pw="app-title">
                    {title}
                  </h1>
                )}
                {titleBadge}
              </div>
              {subtitle ? (
                subtitleTip ? (
                  <WithTooltip tip={subtitleTip}>
                    <p className="cursor-help text-sm text-muted-foreground" data-pw="app-subtitle">
                      {subtitle}
                    </p>
                  </WithTooltip>
                ) : (
                  <p className="text-sm text-muted-foreground" data-pw="app-subtitle">
                    {subtitle}
                  </p>
                )
              ) : null}
            </div>
            <nav className="flex flex-wrap gap-1" data-pw="app-nav">
              {nav.map((item) => {
                const active = item.href === activeHref;
                const link = (
                  <Link
                    href={item.href}
                    data-pw={
                      item.pw ?? `nav-${item.href.replace(/\//g, "-").replace(/^-/, "") || "home"}`
                    }
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                    )}
                    prefetch={false}
                  >
                    {item.label}
                  </Link>
                );
                return (
                  <span key={item.href} className="inline-flex">
                    {item.tip ? <WithTooltip tip={item.tip}>{link}</WithTooltip> : link}
                  </span>
                );
              })}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6" data-pw="app-main">
          {children}
        </main>
        <React.Suspense fallback={null}>
          <Toast />
        </React.Suspense>
      </div>
    </TooltipProvider>
  );
}
