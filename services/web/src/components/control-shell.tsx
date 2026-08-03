"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@auto-harness/ui";

const NAV = [
  { href: "/", label: "Dashboard", pw: "nav-dashboard" },
  { href: "/sessions/new", label: "New session", pw: "nav-session-new" },
  { href: "/sessions", label: "Sessions", pw: "nav-sessions" },
  { href: "/repositories", label: "Repositories", pw: "nav-repositories" },
  { href: "/schedules", label: "Schedules", pw: "nav-schedules" },
  { href: "/agents", label: "Agents", pw: "nav-agents" },
];

export function ControlShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <AppShell
      pw="control-shell"
      title="Control plane"
      subtitle="Org-wide sessions, schedules, and agent fleet"
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
