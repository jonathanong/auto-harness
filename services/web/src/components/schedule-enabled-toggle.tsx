"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { withToast } from "@auto-harness/ui";
import { apiBase } from "@auto-harness/shared";

export function ScheduleEnabledToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [currentEnabled, setCurrentEnabled] = useState(enabled);
  const [pending, start] = useTransition();
  const nextEnabled = !currentEnabled;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={currentEnabled}
      aria-busy={pending}
      aria-label={`${currentEnabled ? "Disable" : "Enable"} schedule`}
      disabled={pending}
      data-pw={`schedule-enabled-${id}`}
      className="inline-flex items-center gap-2 text-sm disabled:cursor-wait disabled:opacity-60"
      onClick={() => {
        start(async () => {
          const response = await fetch(`${apiBase()}/api/v1/schedules/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: nextEnabled }),
          }).catch(() => undefined);
          if (!response?.ok) {
            router.push(
              withToast(
                "/schedules",
                `Could not ${nextEnabled ? "enable" : "disable"} schedule. Try again.`,
              ),
            );
            return;
          }
          setCurrentEnabled(nextEnabled);
          router.refresh();
        });
      }}
    >
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 rounded-full transition-colors ${currentEnabled ? "bg-green-600" : "bg-muted"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${currentEnabled ? "translate-x-[18px]" : "translate-x-0.5"}`}
        />
      </span>
      {pending ? "Saving…" : currentEnabled ? "Enabled" : "Disabled"}
    </button>
  );
}
