"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button, type ButtonProps } from "./button.tsx";
import type { RequestFunction } from "./request-types.ts";
import { WithTooltip } from "./tooltip.tsx";

const DEFAULT_DRAIN_TIP =
  "Stop accepting new sessions on this host. Running sessions finish; idle worktrees go offline. Restart the daemon to clear drain — not a full process kill.";

export type DrainButtonProps = {
  hostId: string;
  label?: string;
  pendingLabel?: string;
  size?: ButtonProps["size"];
  tip?: string;
  pw?: string;
  /** Request boundary; injectable for consumers that provide an in-memory transport. */
  request?: RequestFunction;
};

/** Drain a host — pure REST against the same-origin `/api/v1` proxy, no app wiring needed. */
export function DrainButton({
  hostId,
  label = "Drain",
  pendingLabel = "…",
  size = "default",
  tip = DEFAULT_DRAIN_TIP,
  pw,
  request = fetch,
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
            await request("/api/v1/hosts/drain", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ hostId }),
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
