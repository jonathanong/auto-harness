"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

const DRAIN_TIP =
  "Stop new sessions on this agent. Running sessions finish; idle worktrees go offline. Re-register (restart daemon) to clear drain. Not a full process kill.";

export function AgentDrainButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip={DRAIN_TIP}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
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
        {pending ? "…" : "Drain"}
      </Button>
    </WithTooltip>
  );
}
