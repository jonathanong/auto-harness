"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Label, WithTooltip, showToast, withToast } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";
import { decodeSessionRoutingFormData, type SessionTarget } from "../session-target.ts";
import { SessionPriorityLabelFields } from "./session-priority-label-fields.tsx";
import { SessionPromptField } from "./session-prompt-field.tsx";
import { SessionRoutingFields } from "./session-routing-fields.tsx";
import type { SessionCloneDraft } from "../session-clone-draft.ts";
import { SessionCreateDetailFields } from "./session-create-detail-fields.tsx";

export function CreateSessionForm({
  targets,
  repositories,
  availableLabels = [],
  initialValues,
}: {
  targets: SessionTarget[];
  repositories: Array<{ id: string; name: string }>;
  availableLabels?: string[];
  initialValues?: SessionCloneDraft | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <form
      className="space-y-4"
      data-pw="form-create-session"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const { target, fallbacks } = decodeSessionRoutingFormData(fd);
        const body = {
          repositoryId: String(fd.get("repositoryId") ?? ""),
          prompt: String(fd.get("prompt") ?? ""),
          target,
          fallbacks,
          queueTtlSeconds: Number(fd.get("queueTtlSeconds") ?? 691200),
          timeout: Number(fd.get("timeout") ?? 600),
          priority: Number(fd.get("priority") ?? 0),
          requiredLabels: fd.getAll("requiredLabels").map(String),
          ref: String(fd.get("ref") ?? "") || undefined,
          concurrencyId: String(fd.get("concurrencyId") ?? "").trim() || undefined,
          source: "ui",
        };
        setPending(true);
        void (async () => {
          const res = await fetch(`${apiBase()}/api/v1/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            showToast(await apiErrorMessage(res), {
              variant: "destructive",
              pw: "create-session-error",
            });
            setPending(false);
            return;
          }
          const text = await res.text();
          let id = "";
          let created = true;
          let activeSessionId = "";
          try {
            const payload = JSON.parse(text) as {
              id?: string;
              created?: boolean;
              activeSessionId?: string;
            };
            id = payload.id ?? "";
            created = payload.created !== false;
            activeSessionId = payload.activeSessionId ?? "";
          } catch {
            /* ignore */
          }
          const targetId = created ? id : activeSessionId || id;
          const message = created
            ? "Session queued."
            : "A session with this concurrency ID is already active; showing it instead.";
          setPending(false);
          router.push(
            targetId
              ? withToast(`/sessions/${encodeURIComponent(targetId)}`, message)
              : withToast("/sessions", message),
          );
        })();
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="repositoryId"
          tip="Catalog repository id (control-plane repository), not necessarily a filesystem path"
        >
          Repository id
        </Label>
        <select
          id="repositoryId"
          name="repositoryId"
          required
          data-pw="create-session-repository-id"
          defaultValue={initialValues?.repositoryId ?? repositories[0]?.id ?? ""}
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
      <SessionPriorityLabelFields
        availableLabels={availableLabels}
        initialPriority={initialValues?.priority}
        initialRequiredLabels={initialValues?.requiredLabels}
      />
      <div className="space-y-1">
        <SessionRoutingFields
          targets={targets}
          prefix="create-session"
          initialTarget={initialValues?.target}
          initialFallbacks={initialValues?.fallbacks}
        />
      </div>
      <SessionPromptField initialValue={initialValues?.prompt} />
      <SessionCreateDetailFields initialValues={initialValues} />
      <WithTooltip
        tip={
          repositories.length === 0
            ? "Add a repository first"
            : targets.length === 0
              ? "Add a provider or command first"
              : "Queue a session for assignment to an online agent worktree"
        }
      >
        <Button
          type="submit"
          disabled={pending || targets.length === 0 || repositories.length === 0}
          data-pw="create-session-submit"
        >
          {pending ? "Creating…" : "Create session"}
        </Button>
      </WithTooltip>
    </form>
  );
}
