"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

export function AgentDrainButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
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
  );
}
