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

/** A labeled cluster of nav items (e.g. "Operate", "Catalog") — rendered in one scrolling row. */
export type NavGroup = {
  label?: string;
  items: NavItem[];
};

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
  children: React.ReactNode;
  className?: string;
  /** Root data-pw (e.g. control-shell / host-shell) */
  pw?: string;
};

function isNavGroups(nav: NavItem[] | NavGroup[]): nav is NavGroup[] {
  return nav[0] !== undefined && "items" in nav[0];
}

function navGroups(nav: NavItem[] | NavGroup[]): NavGroup[] {
  return isNavGroups(nav) ? nav : [{ items: nav }];
}

function matchesRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The single most specific nav href matching `pathname`, or null. A blind per-item prefix
 * check would light up both "/sessions" and "/sessions/new" on `/sessions/new` — comparing
 * every href against the whole set and keeping only the longest match means a shorter
 * sibling href never wins once a more specific one also matches.
 */
function activeNavHref(pathname: string | undefined, groups: NavGroup[]): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const item of groups.flatMap((g) => g.items)) {
    if (!matchesRoute(pathname, item.href)) continue;
    if (best === null || item.href.length > best.length) best = item.href;
  }
  return best;
}

/**
 * Whether `el` has more nav content past its left/right edge right now — recomputed on
 * scroll and on resize, since the grouped nav can overflow at perfectly ordinary desktop
 * widths and a scrollable-but-unmarked row is easy to miss (nothing about a `<nav>` hints
 * "there's more, scroll me" the way a `<select>` or carousel usually does).
 */
function useNavOverflow(ref: React.RefObject<HTMLElement | null>, groups: NavGroup[]) {
  const [overflow, setOverflow] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setOverflow({
        left: el.scrollLeft > 0,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
    // `groups` isn't read inside the effect, but a nav-content change can change whether
    // the row overflows, so re-measure whenever the rendered items change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, groups]);
  return overflow;
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
  // A flat NavItem[] gets wrapped in a new array literal by navGroups() on every call —
  // memoized so useNavOverflow's effect (which unconditionally calls setState) doesn't
  // rerun, and therefore doesn't loop, on every render.
  const groups = React.useMemo(() => navGroups(nav), [nav]);
  const activeHref = activeNavHref(pathname, groups);
  const navRef = React.useRef<HTMLElement>(null);
  const overflow = useNavOverflow(navRef, groups);
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
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <Link href="/" data-pw="app-title" className="shrink-0 hover:opacity-80">
              {titleEl}
            </Link>
            <div className="relative min-w-0">
              <nav
                ref={navRef}
                className="flex flex-nowrap items-center gap-1 overflow-x-auto"
                data-pw="app-nav"
              >
                {groups.map((group, groupIndex) => (
                  <React.Fragment key={group.label ?? groupIndex}>
                    {groupIndex > 0 ? (
                      <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                    ) : null}
                    {group.label ? (
                      <span className="shrink-0 whitespace-nowrap px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </span>
                    ) : null}
                    {group.items.map((item) => {
                      const active = item.href === activeHref;
                      const link = (
                        <Link
                          href={item.href}
                          data-pw={
                            item.pw ??
                            `nav-${item.href.replace(/\//g, "-").replace(/^-/, "") || "home"}`
                          }
                          className={cn(
                            "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
                        <span key={item.href} className="inline-flex shrink-0">
                          {item.tip ? <WithTooltip tip={item.tip}>{link}</WithTooltip> : link}
                        </span>
                      );
                    })}
                  </React.Fragment>
                ))}
              </nav>
              {overflow.left ? (
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent"
                  aria-hidden="true"
                  data-pw="app-nav-fade-left"
                />
              ) : null}
              {overflow.right ? (
                <div
                  className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent"
                  aria-hidden="true"
                  data-pw="app-nav-fade-right"
                />
              ) : null}
            </div>
          </div>
          {subtitle || titleBadge ? (
            <div className="border-t border-border/60 bg-muted/30">
              <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-1.5">
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
