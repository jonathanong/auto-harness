"use client";

import { usePathname } from "next/navigation";
import { AppShell, StatusBadge, WithTooltip } from "@auto-harness/ui";

const NAV = [
  {
    href: "/repositories",
    label: "Repositories",
    pw: "nav-repositories",
    tip: "Host repository paths and worktrees, hierarchical by repository",
  },
  {
    href: "/sessions",
    label: "Sessions",
    pw: "nav-sessions",
    tip: "Sessions assigned to this host",
  },
  {
    href: "/settings",
    label: "Settings",
    pw: "nav-settings",
    tip: "Drain control and raw host inventory JSON",
  },
];

export function HostShell({
  agentId,
  online,
  children,
}: {
  agentId: string;
  /** Undefined when the online-status fetch failed — renders no badge. */
  online?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  return (
    <AppShell
      pw="host-shell"
      title="Host pane"
      titleTip="Per-host UI for one agent identity (HARNESS_AGENT_ID)"
      titleBadge={
        online === undefined ? null : (
          <WithTooltip tip="Live WebSocket connection to the control plane">
            <span data-pw="host-shell-online">
              <StatusBadge status={String(online)} />
            </span>
          </WithTooltip>
        )
      }
      subtitle={`Host UI for ${agentId}`}
      subtitleTip={`Managing agentId “${agentId}”. Repos/worktrees here must exist on this machine.`}
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
