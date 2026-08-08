"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";
import { decodeSessionTargetOptionValue, type SessionTarget } from "../session-target.ts";
import { SessionTargetSelect } from "./session-target-select.tsx";

export function ScheduleCreateForm({ targets }: { targets: SessionTarget[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-create-schedule"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const target = decodeSessionTargetOptionValue(String(fd.get("target") ?? ""));
        const body = {
          repositoryId: String(fd.get("repositoryId") ?? ""),
          name: String(fd.get("name") ?? ""),
          ...target,
          cron: String(fd.get("cron") ?? ""),
          timeout: Number(fd.get("timeout") ?? 600),
          nextRunAt: String(fd.get("nextRunAt") ?? new Date().toISOString()),
          ref: String(fd.get("ref") ?? "") || undefined,
        };
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/schedules`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            setError(await res.text());
            return;
          }
          form.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="repositoryId"
          tip="Catalog repository id this schedule creates sessions for"
        >
          repositoryId
        </Label>
        <Input
          id="repositoryId"
          name="repositoryId"
          required
          defaultValue="demo"
          data-pw="schedule-repository-id"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name" tip="Display name for this schedule">
          name
        </Label>
        <Input id="name" name="name" required data-pw="schedule-name" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="target" tip="Provider account (cascade-resolved) or standalone command">
          target
        </Label>
        <SessionTargetSelect targets={targets} id="target" name="target" dataPw="schedule-target" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cron" tip="Five-field cron expression (UTC) for automatic runs">
          cron
        </Label>
        <Input id="cron" name="cron" required defaultValue="0 * * * *" data-pw="schedule-cron" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="timeout" tip="Session timeout in seconds for each scheduled run">
            timeout
          </Label>
          <Input id="timeout" name="timeout" type="number" defaultValue={600} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ref" tip="Git ref checked out for scheduled sessions">
            ref
          </Label>
          <Input id="ref" name="ref" defaultValue="main" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="nextRunAt" tip="First (or next) fire time as ISO-8601 timestamp">
          nextRunAt (ISO)
        </Label>
        <Input id="nextRunAt" name="nextRunAt" defaultValue={new Date().toISOString()} />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="schedule-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Save a cron schedule that enqueues sessions on the control plane">
        <Button type="submit" disabled={pending} data-pw="schedule-submit">
          {pending ? "Saving…" : "Create schedule"}
        </Button>
      </WithTooltip>
    </form>
  );
}
