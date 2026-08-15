"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, Label, WithTooltip, withToast } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";
import { decodeSessionRoutingFormData, type SessionTarget } from "../session-target.ts";
import { SessionPriorityLabelFields } from "./session-priority-label-fields.tsx";
import { SessionPromptField } from "./session-prompt-field.tsx";
import { SessionRoutingFields } from "./session-routing-fields.tsx";
import type { SessionCloneDraft } from "../session-clone-draft.ts";
import { SessionCreateDetailFields } from "./session-create-detail-fields.tsx";

export function CreateSessionForm({
  targets,
  availableLabels = [],
  initialValues,
}: {
  targets: SessionTarget[];
  availableLabels?: string[];
  initialValues?: SessionCloneDraft | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      data-pw="form-create-session"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
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
          const text = await res.text();
          if (!res.ok) {
            setError(text);
            setPending(false);
            return;
          }
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
        <Input
          id="repositoryId"
          name="repositoryId"
          required
          defaultValue={initialValues?.repositoryId ?? "demo"}
          data-pw="create-session-repository-id"
        />
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
      {error ? (
        <p className="text-sm text-red-700" data-pw="create-session-error">
          {error}
        </p>
      ) : null}
      <WithTooltip
        tip={
          targets.length === 0
            ? "Add a provider or command first"
            : "Queue a session for assignment to an online agent worktree"
        }
      >
        <Button
          type="submit"
          disabled={pending || targets.length === 0}
          data-pw="create-session-submit"
        >
          {pending ? "Creating…" : "Create session"}
        </Button>
      </WithTooltip>
    </form>
  );
}
