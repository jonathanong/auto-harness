/* eslint-disable max-lines -- schedule submission and structured execution controls share one form. */
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, showToast } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";
import {
  decodeSessionRoutingFormData,
  type SessionTarget,
  type SessionTargetSelection,
} from "../session-target.ts";
import { SchedulePromptField } from "./schedule-prompt-field.tsx";
import { SessionRoutingFields } from "./session-routing-fields.tsx";
import { SessionExecutionMode } from "./session-execution-mode.tsx";
import { WorkspaceSessionFields, type WorkspacePoolOption } from "./workspace-session-fields.tsx";

export type EditableSchedule = {
  id: string;
  repositoryId: string;
  name: string;
  target: SessionTargetSelection;
  fallbacks: SessionTargetSelection[];
  targetDisplayNames: string[];
  cron: string;
  enabled: boolean;
  timeout: number;
  queueTtlSeconds: number;
  ref?: string;
  concurrencyId?: string | null;
  activeSessionId?: string | null;
  prompt?: string;
  workspacePoolId?: string | null;
  setupProfileId?: string | null;
  destroyWorkspaceAfter?: boolean | null;
};

export function ScheduleEditForm({
  schedule,
  targets,
  workspacePools = [],
  canWriteExecConfig = false,
}: {
  schedule: EditableSchedule;
  targets: SessionTarget[];
  workspacePools?: WorkspacePoolOption[];
  canWriteExecConfig?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"repository" | "workspace">(
    schedule.workspacePoolId ? "workspace" : "repository",
  );
  const [workspacePoolId, setWorkspacePoolId] = useState(schedule.workspacePoolId ?? "");
  const pools =
    schedule.workspacePoolId && !workspacePools.some((pool) => pool.id === workspacePoolId)
      ? [
          ...workspacePools,
          {
            id: schedule.workspacePoolId,
            name: schedule.workspacePoolId,
            setupProfiles: schedule.setupProfileId
              ? [{ id: schedule.setupProfileId, name: schedule.setupProfileId }]
              : [],
            destroyWorkspaceAfter: schedule.destroyWorkspaceAfter ?? false,
          },
        ]
      : workspacePools;

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-edit-schedule"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const { target, fallbacks } = decodeSessionRoutingFormData(fd);
        const destroyWorkspaceAfter = String(fd.get("destroyWorkspaceAfter") ?? "inherit");
        const body = {
          repositoryId: mode === "workspace" ? null : String(fd.get("repositoryId") ?? ""),
          name: String(fd.get("name") ?? ""),
          target,
          fallbacks,
          queueTtlSeconds: Number(fd.get("queueTtlSeconds") ?? schedule.queueTtlSeconds),
          cron: String(fd.get("cron") ?? ""),
          timeout: Number(fd.get("timeout") ?? 600),
          enabled: fd.get("enabled") === "on",
          ref: mode === "workspace" ? undefined : String(fd.get("ref") ?? "") || undefined,
          concurrencyId: String(fd.get("concurrencyId") ?? "").trim(),
          prompt: String(fd.get("prompt") ?? ""),
          ...(mode === "workspace"
            ? {
                workspacePoolId,
                // Unlike creation, editing must explicitly clear a prior
                // profile or cleanup override when the operator selects the
                // pool policy. Omitting those fields would retain the stored
                // override in the service merge.
                setupProfileId: String(fd.get("setupProfileId") ?? "") || null,
                destroyWorkspaceAfter:
                  destroyWorkspaceAfter === "inherit" ? null : destroyWorkspaceAfter === "true",
              }
            : {}),
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
            showToast(await apiErrorMessage(res), {
              variant: "destructive",
              pw: "edit-schedule-error",
            });
            return;
          }
          router.refresh();
        });
      }}
    >
      <SessionExecutionMode mode={mode} onModeChange={setMode} selectorPrefix="edit-schedule" />
      {mode === "repository" ? (
        <div className="space-y-1">
          <Label htmlFor="repositoryId" tip="Catalog repository id">
            Repository ID
          </Label>
          <Input
            id="repositoryId"
            name="repositoryId"
            required
            defaultValue={schedule.repositoryId}
            data-pw="edit-schedule-repository-id"
          />
        </div>
      ) : (
        <WorkspaceSessionFields
          pools={pools}
          poolId={workspacePoolId}
          onPoolIdChange={setWorkspacePoolId}
          initialPoolId={schedule.workspacePoolId ?? undefined}
          initialProfileId={schedule.setupProfileId ?? undefined}
          initialDestroyWorkspaceAfter={schedule.destroyWorkspaceAfter ?? undefined}
          canWriteExecConfig={canWriteExecConfig}
          selectorPrefix="edit-schedule"
        />
      )}
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
        {mode === "repository" ? (
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
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="concurrencyId" tip="Stable ID shared by scheduled runs">
          Concurrency ID Override
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
      <Button type="submit" disabled={pending} data-pw="edit-schedule-submit">
        {pending ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}
