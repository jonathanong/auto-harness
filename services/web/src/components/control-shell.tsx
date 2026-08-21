"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppShell, cn, type NavGroup, ThemeToggle, Toast, WithTooltip } from "@auto-harness/ui";

import { LogoutButton } from "./logout-button.tsx";
import { KeyboardShortcuts } from "./keyboard-shortcuts.tsx";

const NAV: NavGroup[] = [
  {
    label: "Operate",
    pw: "nav-group-operate",
    items: [
      {
        href: "/",
        label: "Dashboard",
        pw: "nav-dashboard",
        tip: "Fleet overview: running/queued sessions and hosts online",
      },
      {
        href: "/sessions",
        label: "Sessions",
        pw: "nav-sessions",
        tip: "Browse and filter session history by status",
      },
      {
        href: "/schedules",
        label: "Schedules",
        pw: "nav-schedules",
        tip: "Cron schedules that create sessions on a timer",
      },
    ],
  },
  {
    label: "Catalog",
    pw: "nav-group-catalog",
    items: [
      {
        href: "/repositories",
        label: "Repositories",
        pw: "nav-repositories",
        tip: "Catalog repositories and attach local paths to hosts",
      },
      {
        href: "/providers",
        label: "Providers",
        pw: "nav-providers",
        tip: "AI CLI vendors (claude, codex, grok…) and their accounts",
      },
      {
        href: "/commands",
        label: "Commands",
        pw: "nav-commands",
        tip: "Named argv invocations, standalone or owned by a provider",
      },
    ],
  },
  {
    label: "Fleet",
    pw: "nav-group-fleet",
    items: [
      {
        href: "/worktrees",
        label: "Worktrees",
        pw: "nav-worktrees",
        tip: "Fleet worktrees grouped by repository",
      },
      {
        href: "/hosts",
        label: "Hosts",
        pw: "nav-hosts",
        tip: "Add host slots, view online/offline fleet, drain hosts",
      },
    ],
  },
  {
    label: "Settings",
    pw: "nav-group-settings",
    items: [
      {
        href: "/settings",
        label: "Settings",
        pw: "nav-settings",
        tip: "View your account and manage admin-only service accounts and integrations",
      },
    ],
  },
];

function NewSessionButton({ active }: { active: boolean }) {
  return (
    <WithTooltip tip="Create a one-off session for a repository with a Provider or Command target">
      <Link
        href="/sessions/new"
        data-pw="nav-session-new"
        prefetch={false}
        className={cn(
          "inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "bg-muted text-foreground"
            : "bg-primary text-primary-foreground hover:opacity-90",
        )}
      >
        New session
      </Link>
    </WithTooltip>
  );
}

export function ControlShell({
  children,
  authRequired = false,
}: {
  children: React.ReactNode;
  authRequired?: boolean;
}) {
  const pathname = usePathname() ?? "/";
  if (pathname === "/login") {
    return (
      <>
        {children}
        <Suspense fallback={null}>
          <Toast />
        </Suspense>
      </>
    );
  }
  const newSessionActive = pathname === "/sessions/new" || pathname.startsWith("/sessions/new/");
  return (
    <AppShell
      pw="control-shell"
      title="Control plane"
      titleTip="Org-wide control plane: sessions, schedules, catalog, and host fleet"
      subtitle="Org-wide sessions, schedules, and host fleet"
      subtitleTip="Hosts self-register over the API/WebSocket; attach repositories on the Hosts page"
      titleBadge={
        <div className="flex items-center gap-1">
          <NewSessionButton active={newSessionActive} />
          <ThemeToggle />
          <KeyboardShortcuts />
          {authRequired ? <LogoutButton /> : null}
        </div>
      }
      nav={NAV}
      pathname={pathname}
      extraActiveHrefs={["/sessions/new"]}
    >
      {children}
    </AppShell>
  );
}
