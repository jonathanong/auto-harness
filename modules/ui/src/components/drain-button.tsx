"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { apiErrorMessage } from "@auto-harness/shared";

import { Button, type ButtonProps } from "./button.tsx";
import type { RequestFunction } from "./request-types.ts";
import { WithTooltip } from "./tooltip.tsx";

const DEFAULT_DRAIN_TIP =
  "Stop accepting new sessions on this host. Running sessions finish; idle worktrees go offline. Restart the daemon to clear drain — not a full process kill.";
const MAX_DRAIN_ERROR_LENGTH = 240;
const DRAIN_ERROR_FALLBACK = "Could not drain host. Please try again.";

function boundedDrainError(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const prefixed = `Could not drain host: ${normalized}`;
  return prefixed.length <= MAX_DRAIN_ERROR_LENGTH
    ? prefixed
    : `${prefixed.slice(0, MAX_DRAIN_ERROR_LENGTH - 1)}…`;
}

function thrownDrainError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return boundedDrainError(cause.message);
  if (typeof cause === "string" && cause.trim()) return boundedDrainError(cause);
  return DRAIN_ERROR_FALLBACK;
}

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const drain = () => {
    // The disabled attribute covers normal clicks, while this ref also closes the
    // same-tick/programmatic gap before React has rendered the pending state.
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    void (async () => {
      let succeeded = false;
      try {
        const response = await request("/api/v1/hosts/drain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hostId }),
        });
        if (!response.ok) {
          setError(boundedDrainError(await apiErrorMessage(response)));
          return;
        }
        succeeded = true;
      } catch (cause) {
        setError(thrownDrainError(cause));
      } finally {
        inFlight.current = false;
        setPending(false);
      }
      if (succeeded) router.refresh();
    })();
  };

  return (
    <div className="space-y-1">
      <WithTooltip tip={tip}>
        <Button
          type="button"
          size={size}
          variant="outline"
          disabled={pending}
          aria-busy={pending}
          data-pw={pw}
          onClick={drain}
        >
          {pending ? pendingLabel : label}
        </Button>
      </WithTooltip>
      {error ? (
        <p
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="max-w-xs break-words text-xs text-red-700"
          data-pw={pw ? `${pw}-error` : "drain-error"}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
