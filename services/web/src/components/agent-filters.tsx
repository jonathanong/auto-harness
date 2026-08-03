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
    <div className={`flex items-end gap-3 ${pending ? "opacity-70" : ""}`}>
      <div className="space-y-1">
        <Label htmlFor="online">Online</Label>
        <select
          id="online"
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
