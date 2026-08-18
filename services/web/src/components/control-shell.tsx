"use client";

import { usePathname } from "next/navigation";
import { AppShell, type NavGroup, ThemeToggle } from "@auto-harness/ui";

import { LogoutButton } from "./logout-button.tsx";
import { KeyboardShortcuts } from "./keyboard-shortcuts.tsx";

const NAV: NavGroup[] = [
  {
    label: "Operate",
    items: [
      {
        href: "/",
        label: "Dashboard",
        pw: "nav-dashboard",
        tip: "Fleet overview: running/queued sessions and hosts online",
      },
      {
        href: "/sessions/new",
        label: "New session",
        pw: "nav-session-new",
        tip: "Create a one-off session for a repository with a Provider or Command target",
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

export function ControlShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  if (pathname === "/login") return <>{children}</>;
  return (
    <AppShell
      pw="control-shell"
      title="Control plane"
      titleTip="Org-wide control plane: sessions, schedules, catalog, and host fleet"
      subtitle="Org-wide sessions, schedules, and host fleet"
      subtitleTip="Hosts self-register over the API/WebSocket; configure host paths on the host pane"
      titleBadge={
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <KeyboardShortcuts />
          <LogoutButton />
        </div>
      }
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
