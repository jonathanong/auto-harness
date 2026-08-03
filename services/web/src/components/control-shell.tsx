"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@auto-harness/ui";

const NAV = [
  {
    href: "/",
    label: "Dashboard",
    pw: "nav-dashboard",
    tip: "Fleet overview: running/queued sessions and agents online",
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
    tip: "Catalog repositories and attach local paths to agents",
  },
  {
    href: "/worktrees",
    label: "Worktrees",
    pw: "nav-worktrees",
    tip: "Fleet worktrees grouped by repository",
  },
  {
    href: "/schedules",
    label: "Schedules",
    pw: "nav-schedules",
    tip: "Cron schedules that create sessions on a timer",
  },
  {
    href: "/agents",
    label: "Agents",
    pw: "nav-agents",
    tip: "Add agent slots, view online/offline fleet, drain agents",
  },
];

export function ControlShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <AppShell
      pw="control-shell"
      title="Control plane"
      titleTip="Org-wide control plane: sessions, schedules, catalog, and agent fleet"
      subtitle="Org-wide sessions, schedules, and agent fleet"
      subtitleTip="Agents self-register over the API/WebSocket; configure host paths on the agent pane"
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
