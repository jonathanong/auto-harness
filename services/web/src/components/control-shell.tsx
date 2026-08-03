"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@auto-harness/ui";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/sessions/new", label: "New session" },
  { href: "/sessions", label: "Sessions" },
  { href: "/repositories", label: "Repositories" },
  { href: "/schedules", label: "Schedules" },
  { href: "/agents", label: "Agents" },
];

export function ControlShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <AppShell
      title="Control plane"
      subtitle="Org-wide sessions, schedules, and agent fleet"
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
