"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "../lib/utils.ts";
import { activeNavHref, AppNav, navGroups, type NavGroup, type NavItem } from "./app-nav.tsx";
import { Toast } from "./toast.tsx";
import { TooltipProvider, WithTooltip } from "./tooltip.tsx";

export type { NavGroup, NavItem };

export type AppShellProps = {
  title: string;
  subtitle?: string;
  titleTip?: string;
  subtitleTip?: string;
  /** Rendered in a slim secondary row below title+nav (e.g. theme toggle, shortcuts, logout). */
  titleBadge?: React.ReactNode;
  /** A flat list (rendered as one ungrouped cluster) or pre-grouped for a large nav. */
  nav: NavItem[] | NavGroup[];
  /** Current path for active nav highlighting */
  pathname?: string;
  /**
   * Extra hrefs that compete in longest-prefix active matching without appearing in the nav
   * (e.g. a header-row action that would otherwise lose to a shorter sibling like `/sessions`).
   */
  extraActiveHrefs?: string[];
  children: React.ReactNode;
  className?: string;
  /** Root data-pw (e.g. control-shell / host-shell) */
  pw?: string;
};

/** Shared chrome for control-plane and host pane apps. */
export function AppShell({
  title,
  subtitle,
  titleTip,
  subtitleTip,
  titleBadge,
  nav,
  pathname,
  extraActiveHrefs = [],
  children,
  className,
  pw,
}: AppShellProps) {
  const groups = React.useMemo(() => navGroups(nav), [nav]);
  const activeHref = activeNavHref(pathname, groups, extraActiveHrefs);
  const titleEl = titleTip ? (
    <WithTooltip tip={titleTip}>
      <h1 className="inline-block cursor-help text-lg font-semibold tracking-tight">{title}</h1>
    </WithTooltip>
  ) : (
    <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
  );

  return (
    <TooltipProvider>
      <div className={cn("min-h-screen bg-background", className)} data-pw={pw}>
        <header className="border-b border-border" data-pw="app-header">
          <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <Link href="/" data-pw="app-title" className="shrink-0 hover:opacity-80">
              {titleEl}
            </Link>
            <AppNav groups={groups} activeHref={activeHref} />
          </div>
          {subtitle || titleBadge ? (
            <div className="border-t border-border/60 bg-muted/30">
              <div className="flex items-center justify-between gap-4 px-4 py-1.5">
                {subtitle ? (
                  subtitleTip ? (
                    <WithTooltip tip={subtitleTip}>
                      <p
                        className="cursor-help text-xs text-muted-foreground"
                        data-pw="app-subtitle"
                      >
                        {subtitle}
                      </p>
                    </WithTooltip>
                  ) : (
                    <p className="text-xs text-muted-foreground" data-pw="app-subtitle">
                      {subtitle}
                    </p>
                  )
                ) : (
                  <span />
                )}
                {titleBadge}
              </div>
            </div>
          ) : null}
        </header>
        <main className="px-4 py-6" data-pw="app-main">
          {children}
        </main>
        <React.Suspense fallback={null}>
          <Toast />
        </React.Suspense>
      </div>
    </TooltipProvider>
  );
}
