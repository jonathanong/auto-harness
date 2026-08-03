"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

const DRAIN_TIP =
  "Stop accepting new sessions on this agent. In-flight work finishes; idle worktrees go offline. Restart the agent daemon to take work again (clears drain). Not a full process shutdown.";

export function DrainButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip={DRAIN_TIP}>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        data-pw="agent-drain"
        onClick={() => {
          start(async () => {
            await fetch(`${apiBase()}/api/v1/agents/drain`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agentId }),
            });
            router.refresh();
          });
        }}
      >
        {pending ? "Draining…" : "Drain this agent"}
      </Button>
    </WithTooltip>
  );
}
