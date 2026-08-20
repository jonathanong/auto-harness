"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, WithTooltip, withToast } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";
import {
  decodeSessionRoutingFormData,
  type SessionTarget,
  type SessionTargetSelection,
} from "../session-target.ts";
import { SchedulePromptField } from "./schedule-prompt-field.tsx";
import { SessionRoutingFields } from "./session-routing-fields.tsx";

type ScheduleFormValue = {
  id: string;
  repositoryId: string;
  name: string;
  target: SessionTargetSelection;
  fallbacks: SessionTargetSelection[];
  cron: string;
  timeout: number;
  queueTtlSeconds: number;
  ref?: string;
  prompt?: string;
};

export function ScheduleCreateForm({
  targets,
  repositories,
  schedule,
}: {
  targets: SessionTarget[];
  repositories: Array<{ id: string; name: string }>;
  schedule?: ScheduleFormValue;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw={schedule ? `form-edit-schedule-${schedule.id}` : "form-create-schedule"}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const { target, fallbacks } = decodeSessionRoutingFormData(fd);
        const body = {
          repositoryId: String(fd.get("repositoryId") ?? ""),
          name: String(fd.get("name") ?? ""),
          target,
          fallbacks,
          queueTtlSeconds: Number(fd.get("queueTtlSeconds") ?? 691200),
          cron: String(fd.get("cron") ?? ""),
          timeout: Number(fd.get("timeout") ?? 600),
          ref: String(fd.get("ref") ?? "") || undefined,
          concurrencyId: String(fd.get("concurrencyId") ?? "").trim() || undefined,
          prompt: String(fd.get("prompt") ?? ""),
        };
        start(async () => {
          const res = await fetch(
            schedule
              ? `${apiBase()}/api/v1/schedules/${encodeURIComponent(schedule.id)}`
              : `${apiBase()}/api/v1/schedules`,
            {
              method: schedule ? "PATCH" : "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          if (!res.ok) {
            setError(await apiErrorMessage(res));
            return;
          }
          const payload = (await res.json()) as { id?: string };
          if (payload.id) {
            router.push(
              withToast(`/schedules/${encodeURIComponent(payload.id)}`, "Schedule created."),
            );
          } else {
            form.reset();
            router.refresh();
          }
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="repositoryId"
          tip="Catalog repository id (control-plane repository), not necessarily a filesystem path"
        >
          repository
        </Label>
        <select
          id="repositoryId"
          name="repositoryId"
          required
          data-pw="schedule-repository-id"
          defaultValue={schedule?.repositoryId ?? repositories[0]?.id ?? ""}
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        >
          {repositories.length === 0 ? <option value="">(none — add a repository)</option> : null}
          {repositories.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="name">name</Label>
        <Input
          id="name"
          name="name"
          required
          defaultValue={schedule?.name}
          data-pw="schedule-name"
        />
      </div>
      <SchedulePromptField defaultValue={schedule?.prompt} />
      <SessionRoutingFields
        targets={targets}
        prefix="schedule"
        initialTarget={schedule?.target}
        initialFallbacks={schedule?.fallbacks}
      />
      <div className="space-y-1">
        <Label htmlFor="cron">cron</Label>
        <Input
          id="cron"
          name="cron"
          required
          defaultValue={schedule?.cron ?? "0 * * * *"}
          data-pw="schedule-cron"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="timeout">timeout</Label>
          <Input
            id="timeout"
            name="timeout"
            type="number"
            defaultValue={schedule?.timeout ?? 600}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ref">ref</Label>
          <Input id="ref" name="ref" defaultValue={schedule?.ref ?? "main"} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="queueTtlSeconds">queue TTL (s)</Label>
        <Input
          id="queueTtlSeconds"
          name="queueTtlSeconds"
          type="number"
          min={1}
          defaultValue={schedule?.queueTtlSeconds ?? 691200}
          data-pw="schedule-queue-ttl"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="concurrencyId">Concurrency ID override</Label>
        <Input
          id="concurrencyId"
          name="concurrencyId"
          placeholder="auto-generated for this schedule"
          data-pw="schedule-concurrency-id"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="schedule-error">
          {error}
        </p>
      ) : null}
      <WithTooltip
        tip={
          targets.length === 0
            ? "Add a provider or command first"
            : "Save a cron schedule that enqueues sessions on the control plane"
        }
      >
        <Button
          type="submit"
          disabled={pending || targets.length === 0}
          data-pw={schedule ? `schedule-edit-submit-${schedule.id}` : "schedule-submit"}
        >
          {pending ? "Saving…" : schedule ? "Save schedule" : "Create schedule"}
        </Button>
      </WithTooltip>
    </form>
  );
}
