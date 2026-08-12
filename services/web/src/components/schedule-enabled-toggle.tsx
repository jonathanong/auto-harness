"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { withToast } from "@auto-harness/ui";
import { apiBase } from "@auto-harness/shared";

export function ScheduleEnabledToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const nextEnabled = !enabled;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-busy={pending}
      aria-label={`${enabled ? "Disable" : "Enable"} schedule`}
      disabled={pending}
      data-pw={`schedule-enabled-${id}`}
      className="inline-flex items-center gap-2 text-sm disabled:cursor-wait disabled:opacity-60"
      onClick={() => {
        start(async () => {
          const response = await fetch(`${apiBase()}/api/v1/schedules/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: nextEnabled }),
          });
          if (!response.ok) {
            router.push(
              withToast(
                "/schedules",
                `Could not ${nextEnabled ? "enable" : "disable"} schedule. Try again.`,
              ),
            );
            return;
          }
          router.refresh();
        });
      }}
    >
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 rounded-full transition-colors ${enabled ? "bg-green-600" : "bg-muted"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-[18px]" : "translate-x-0.5"}`}
        />
      </span>
      {pending ? "Saving…" : enabled ? "Enabled" : "Disabled"}
    </button>
  );
}
