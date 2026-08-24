"use client";

import Link from "next/link";

import { cn } from "../lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import { WithTooltip } from "./tooltip.tsx";

export type NavItem = {
  href: string;
  label: string;
  /** Playwright selector: data-pw value */
  pw?: string;
  /** Nav link tooltip */
  tip?: string;
};

/** A labeled cluster of nav items (e.g. "Operate", "Catalog") — each label is a dropdown trigger. */
export type NavGroup = {
  label?: string;
  /** Playwright selector for a labeled group's dropdown trigger */
  pw?: string;
  items: NavItem[];
};

function isNavGroups(nav: NavItem[] | NavGroup[]): nav is NavGroup[] {
  return nav[0] !== undefined && "items" in nav[0];
}

export function navGroups(nav: NavItem[] | NavGroup[]): NavGroup[] {
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
export function activeNavHref(
  pathname: string | undefined,
  groups: NavGroup[],
  extraHrefs: string[],
): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const href of [...groups.flatMap((g) => g.items.map((item) => item.href)), ...extraHrefs]) {
    if (!matchesRoute(pathname, href)) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}

function navItemPw(item: NavItem): string {
  return item.pw ?? `nav-${item.href.replace(/\//g, "-").replace(/^-/, "") || "home"}`;
}

function navItemClass(active: boolean): string {
  return cn(
    "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
    active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
  );
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const link = (
    <Link
      href={item.href}
      data-pw={navItemPw(item)}
      className={navItemClass(active)}
      prefetch={false}
    >
      {item.label}
    </Link>
  );
  return item.tip ? <WithTooltip tip={item.tip}>{link}</WithTooltip> : link;
}

function NavGroupMenu({ group, activeHref }: { group: NavGroup; activeHref: string | null }) {
  const label = group.label ?? "";
  const groupActive = group.items.some((item) => item.href === activeHref);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-pw={group.pw ?? `nav-group-${label.toLowerCase().replace(/\s+/g, "-")}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            "outline-hidden focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60",
            groupActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
          )}
        >
          {label}
          <ChevronDown />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {group.items.map((item) => (
          <DropdownMenuItem key={item.href} asChild>
            <Link
              href={item.href}
              data-pw={navItemPw(item)}
              title={item.tip}
              className={cn(
                "w-full cursor-pointer",
                item.href === activeHref ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
              prefetch={false}
            >
              {item.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppNav({ groups, activeHref }: { groups: NavGroup[]; activeHref: string | null }) {
  return (
    <nav className="flex flex-wrap items-center gap-1" data-pw="app-nav">
      {groups.map((group, groupIndex) => {
        if (!group.label) {
          return (
            <span key={groupIndex} className="contents">
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} active={item.href === activeHref} />
              ))}
            </span>
          );
        }
        return <NavGroupMenu key={group.label} group={group} activeHref={activeHref} />;
      })}
    </nav>
  );
}
