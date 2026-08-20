"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";
import {
  decodeSessionRoutingFormData,
  type SessionTarget,
  type SessionTargetSelection,
} from "../session-target.ts";
import { SchedulePromptField } from "./schedule-prompt-field.tsx";
import { SessionRoutingFields } from "./session-routing-fields.tsx";

export type EditableSchedule = {
  id: string;
  repositoryId: string;
  name: string;
  target: SessionTargetSelection;
  fallbacks: SessionTargetSelection[];
  targetLabels: string[];
  cron: string;
  enabled: boolean;
  timeout: number;
  queueTtlSeconds: number;
  ref?: string;
  concurrencyId?: string | null;
  activeSessionId?: string | null;
  prompt?: string;
};

export function ScheduleEditForm({
  schedule,
  targets,
}: {
  schedule: EditableSchedule;
  targets: SessionTarget[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-edit-schedule"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const { target, fallbacks } = decodeSessionRoutingFormData(fd);
        const body = {
          repositoryId: String(fd.get("repositoryId") ?? ""),
          name: String(fd.get("name") ?? ""),
          target,
          fallbacks,
          queueTtlSeconds: Number(fd.get("queueTtlSeconds") ?? schedule.queueTtlSeconds),
          cron: String(fd.get("cron") ?? ""),
          timeout: Number(fd.get("timeout") ?? 600),
          enabled: fd.get("enabled") === "on",
          ref: String(fd.get("ref") ?? "") || undefined,
          concurrencyId: String(fd.get("concurrencyId") ?? "").trim(),
          prompt: String(fd.get("prompt") ?? ""),
        };
        start(async () => {
          const res = await fetch(
            `${apiBase()}/api/v1/schedules/${encodeURIComponent(schedule.id)}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          if (!res.ok) {
            setError(await apiErrorMessage(res));
            return;
          }
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="repositoryId" tip="Catalog repository id">
          Repository id
        </Label>
        <Input
          id="repositoryId"
          name="repositoryId"
          required
          defaultValue={schedule.repositoryId}
          data-pw="edit-schedule-repository-id"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name" tip="Display name for this schedule">
          Name
        </Label>
        <Input
          id="name"
          name="name"
          required
          defaultValue={schedule.name}
          data-pw="edit-schedule-name"
        />
      </div>
      <SchedulePromptField defaultValue={schedule.prompt} />
      <SessionRoutingFields
        targets={targets}
        prefix="schedule"
        initialTarget={schedule.target}
        initialFallbacks={schedule.fallbacks}
      />
      <div className="space-y-1">
        <Label htmlFor="cron" tip="Five-field cron expression (UTC)">
          Cron
        </Label>
        <Input
          id="cron"
          name="cron"
          required
          defaultValue={schedule.cron}
          data-pw="edit-schedule-cron"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="queueTtlSeconds" tip="Maximum queued lifetime in seconds">
          Queue TTL (s)
        </Label>
        <Input
          id="queueTtlSeconds"
          name="queueTtlSeconds"
          type="number"
          min={1}
          defaultValue={schedule.queueTtlSeconds}
          data-pw="edit-schedule-queue-ttl"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="timeout" tip="Session timeout in seconds">
            Timeout
          </Label>
          <Input
            id="timeout"
            name="timeout"
            type="number"
            defaultValue={schedule.timeout}
            data-pw="edit-schedule-timeout"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ref" tip="Git ref checked out for scheduled sessions">
            Ref
          </Label>
          <Input
            id="ref"
            name="ref"
            defaultValue={schedule.ref ?? ""}
            data-pw="edit-schedule-ref"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="concurrencyId" tip="Stable ID shared by scheduled runs">
          Concurrency ID override
        </Label>
        <Input
          id="concurrencyId"
          name="concurrencyId"
          placeholder="auto-generated for this schedule"
          defaultValue={schedule.concurrencyId ?? ""}
          data-pw="edit-schedule-concurrency-id"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={schedule.enabled}
          data-pw="edit-schedule-enabled"
        />
        Enabled
      </label>
      {error ? (
        <p className="text-sm text-red-700" data-pw="edit-schedule-error">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-pw="edit-schedule-submit">
        {pending ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}
