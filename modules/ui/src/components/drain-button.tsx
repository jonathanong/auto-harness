"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button, type ButtonProps } from "./button.tsx";
import { WithTooltip } from "./tooltip.tsx";

const DEFAULT_DRAIN_TIP =
  "Stop accepting new sessions on this host. Running sessions finish; idle worktrees go offline. Restart the daemon to clear drain — not a full process kill.";

export type DrainButtonProps = {
  agentId: string;
  label?: string;
  pendingLabel?: string;
  size?: ButtonProps["size"];
  tip?: string;
  pw?: string;
};

/** Drain a host — pure REST against the same-origin `/api/v1` proxy, no app wiring needed. */
export function DrainButton({
  agentId,
  label = "Drain",
  pendingLabel = "…",
  size = "default",
  tip = DEFAULT_DRAIN_TIP,
  pw,
}: DrainButtonProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip={tip}>
      <Button
        type="button"
        size={size}
        variant="outline"
        disabled={pending}
        data-pw={pw}
        onClick={() => {
          start(async () => {
            await fetch("/api/v1/agents/drain", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agentId }),
            });
            router.refresh();
          });
        }}
      >
        {pending ? pendingLabel : label}
      </Button>
    </WithTooltip>
  );
}
