"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@auto-harness/ui";

const NAV = [
  {
    href: "/",
    label: "Status",
    pw: "nav-status",
    tip: "This host’s agent id, online status, and drain control",
  },
  {
    href: "/config",
    label: "Host config",
    pw: "nav-config",
    tip: "Repositories and worktrees on this machine (paths are host-local)",
  },
];

export function AgentShell({ agentId, children }: { agentId: string; children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <AppShell
      pw="agent-shell"
      title="Agent pane"
      titleTip="Per-host UI for one agent identity (HARNESS_AGENT_ID)"
      subtitle={`Host UI for ${agentId}`}
      subtitleTip={`Managing agentId “${agentId}”. Repos/worktrees here must exist on this machine.`}
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
