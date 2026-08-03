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
    href: "/repositories",
    label: "Repositories",
    pw: "nav-repositories",
    tip: "Host repository paths for this agent (no auto worktrees)",
  },
  {
    href: "/worktrees",
    label: "Worktrees",
    pw: "nav-worktrees",
    tip: "Worktrees under each repository — hierarchical, explicit ids and paths",
  },
  {
    href: "/sessions",
    label: "Sessions",
    pw: "nav-sessions",
    tip: "Sessions assigned to this agent (cursor-paginated)",
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
