"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { apiErrorMessage } from "@auto-harness/shared";

import { Button, type ButtonProps } from "./button.tsx";
import type { RequestFunction } from "./request-types.ts";
import { WithTooltip } from "./tooltip.tsx";

const DEFAULT_RESUME_TIP =
  "Resume a drained host — clears drain and restores it to scheduling. A no-op if it isn't draining.";
const MAX_RESUME_ERROR_LENGTH = 240;
const RESUME_ERROR_FALLBACK = "Could not resume host. Please try again.";

function boundedResumeError(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const prefixed = `Could not resume host: ${normalized}`;
  return prefixed.length <= MAX_RESUME_ERROR_LENGTH
    ? prefixed
    : `${prefixed.slice(0, MAX_RESUME_ERROR_LENGTH - 1)}…`;
}

function thrownResumeError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return boundedResumeError(cause.message);
  if (typeof cause === "string" && cause.trim()) return boundedResumeError(cause);
  return RESUME_ERROR_FALLBACK;
}

export type ResumeButtonProps = {
  hostId: string;
  label?: string;
  pendingLabel?: string;
  size?: ButtonProps["size"];
  tip?: string;
  pw?: string;
  /** Request boundary; injectable for consumers that provide an in-memory transport. */
  request?: RequestFunction;
};

/** Resume a drained host — the inverse of DrainButton; pure REST, no app wiring needed. */
export function ResumeButton({
  hostId,
  label = "Resume",
  pendingLabel = "…",
  size = "default",
  tip = DEFAULT_RESUME_TIP,
  pw,
  request = fetch,
}: ResumeButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const resume = () => {
    // The disabled attribute covers normal clicks, while this ref also closes the
    // same-tick/programmatic gap before React has rendered the pending state.
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    void (async () => {
      let succeeded = false;
      try {
        const response = await request("/api/v1/hosts/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hostId }),
        });
        if (!response.ok) {
          setError(boundedResumeError(await apiErrorMessage(response)));
          return;
        }
        succeeded = true;
      } catch (cause) {
        setError(thrownResumeError(cause));
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
          onClick={resume}
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
          data-pw={pw ? `${pw}-error` : "resume-error"}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
