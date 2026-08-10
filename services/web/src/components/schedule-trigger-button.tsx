"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, WithTooltip, withToast } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";

export function ScheduleTriggerButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip="Fire this schedule once now (creates a session immediately)">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          start(async () => {
            const res = await fetch(
              `${apiBase()}/api/v1/schedules/${encodeURIComponent(id)}/trigger`,
              {
                method: "POST",
              },
            );
            if (!res.ok) {
              router.push(
                withToast(`/schedules/${encodeURIComponent(id)}`, "Could not run schedule."),
              );
              return;
            }
            const payload = (await res.json()) as {
              id?: string;
              created?: boolean;
              activeSessionId?: string;
            };
            const created = payload.created !== false;
            const sessionId = created ? payload.id : payload.activeSessionId || payload.id;
            const message = created
              ? "Schedule run queued."
              : "A run with this concurrency ID is already active; showing it instead.";
            router.push(
              sessionId
                ? withToast(`/sessions/${encodeURIComponent(sessionId)}`, message)
                : withToast(`/schedules/${encodeURIComponent(id)}`, message),
            );
          });
        }}
      >
        {pending ? "…" : "Trigger"}
      </Button>
    </WithTooltip>
  );
}
