"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@auto-harness/ui";

import { LogoutButton } from "./logout-button.tsx";

const NAV = [
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
    tip: "Create a one-off session for a repository and command profile",
  },
  {
    href: "/sessions",
    label: "Sessions",
    pw: "nav-sessions",
    tip: "Browse and filter session history by status",
  },
  {
    href: "/repositories",
    label: "Repositories",
    pw: "nav-repositories",
    tip: "Catalog repositories and attach local paths to hosts",
  },
  {
    href: "/worktrees",
    label: "Worktrees",
    pw: "nav-worktrees",
    tip: "Fleet worktrees grouped by repository",
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
  {
    href: "/schedules",
    label: "Schedules",
    pw: "nav-schedules",
    tip: "Cron schedules that create sessions on a timer",
  },
  {
    href: "/hosts",
    label: "Hosts",
    pw: "nav-hosts",
    tip: "Add host slots, view online/offline fleet, drain hosts",
  },
  {
    href: "/settings",
    label: "Settings",
    pw: "nav-settings",
    tip: "View your account and change your password",
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
      titleBadge={<LogoutButton />}
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
