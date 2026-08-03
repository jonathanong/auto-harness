"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

export function ScheduleTriggerButton({ id }: { id: string }) {
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
          await fetch(`${apiBase()}/api/v1/schedules/${encodeURIComponent(id)}/trigger`, {
            method: "POST",
          });
          router.refresh();
        });
      }}
    >
      {pending ? "…" : "Trigger"}
    </Button>
  );
}
