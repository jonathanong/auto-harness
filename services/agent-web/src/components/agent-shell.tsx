"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@auto-harness/ui";

const NAV = [
  { href: "/", label: "Status", pw: "nav-status" },
  { href: "/config", label: "Host config", pw: "nav-config" },
];

export function AgentShell({ agentId, children }: { agentId: string; children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <AppShell
      pw="agent-shell"
      title="Agent pane"
      subtitle={`Host UI for ${agentId}`}
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
