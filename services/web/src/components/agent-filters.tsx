"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Label } from "@auto-harness/ui";

import { agentListHref } from "../lib/url-state.ts";

export function AgentFilters() {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const online = sp.get("online") ?? "all";

  return (
    <div className={`flex items-end gap-3 ${pending ? "opacity-70" : ""}`} data-pw="agent-filters">
      <div className="space-y-1">
        <Label
          htmlFor="online"
          tip="Filter fleet by live WebSocket connection (online) vs host slot only (offline)"
        >
          Online
        </Label>
        <select
          id="online"
          data-pw="agent-filter-online"
          className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
          value={online}
          onChange={(e) => {
            start(() => {
              router.push(agentListHref({ online: e.target.value }));
            });
          }}
        >
          <option value="all">all</option>
          <option value="online">online</option>
          <option value="offline">offline</option>
        </select>
      </div>
    </div>
  );
}
