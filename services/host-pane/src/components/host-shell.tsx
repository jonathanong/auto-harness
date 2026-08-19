"use client";

import { usePathname } from "next/navigation";
import { AppShell, Badge, OnlineStatusBadge, ThemeToggle, WithTooltip } from "@auto-harness/ui";

import { HOST_PANE_DEBUG_ONLY_LABEL } from "../lib/unauthenticated.ts";

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
  hostId,
  online,
  children,
}: {
  hostId: string;
  /** Undefined when the online-status fetch failed — renders no badge. */
  online?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  return (
    <AppShell
      pw="host-shell"
      title="Host pane"
      titleTip="Debug-only local UI for one host identity (HARNESS_HOST_ID). Operators should use the control plane."
      titleBadge={
        <div className="flex items-center gap-1">
          <WithTooltip tip="This UI is debug-only. Operators should use the control plane.">
            <span>
              <Badge variant="warning" data-pw="host-shell-debug-only">
                {HOST_PANE_DEBUG_ONLY_LABEL}
              </Badge>
            </span>
          </WithTooltip>
          <ThemeToggle />
          {online === undefined ? null : (
            <WithTooltip tip="Live WebSocket connection to the control plane">
              <span data-pw="host-shell-online">
                <OnlineStatusBadge online={online} />
              </span>
            </WithTooltip>
          )}
        </div>
      }
      subtitle={`Debug-only — operators should use the control plane. Host UI for ${hostId}`}
      subtitleTip={`Managing hostId “${hostId}”. Repos/worktrees here must exist on this machine.`}
      nav={NAV}
      pathname={pathname}
    >
      {children}
    </AppShell>
  );
}
