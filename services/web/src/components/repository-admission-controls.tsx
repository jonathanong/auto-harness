"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { apiBase, apiErrorMessage, type RepositoryAdmissionState } from "@auto-harness/shared";
import { Button, showToast, WithTooltip } from "@auto-harness/ui";

export function RepositoryAdmissionControls({
  repositoryId,
  state = "active",
  request = fetch,
}: {
  repositoryId: string;
  state?: RepositoryAdmissionState;
  request?: typeof fetch;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmDrain, setConfirmDrain] = useState(false);

  const operate = (operation: "pause" | "drain" | "activate") => {
    start(async () => {
      const response = await request(
        `${apiBase()}/api/v1/repositories/${encodeURIComponent(repositoryId)}/${operation}`,
        { method: "POST" },
      );
      if (!response.ok) {
        showToast(await apiErrorMessage(response), {
          variant: "destructive",
          pw: "repository-admission-error",
        });
        return;
      }
      setConfirmDrain(false);
      showToast(`Repository ${operation} request accepted.`);
      router.refresh();
    });
  };

  return (
    <section
      className="space-y-2 rounded-md border border-border p-4"
      data-pw="repository-admission"
    >
      <h3 className="font-medium">Session admission</h3>
      <p className="text-sm text-muted-foreground">
        Current state: <span className="font-mono">{state}</span>. Pause keeps running sessions;
        drain cancels every queued and running session, then settles paused.
      </p>
      <div className="flex flex-wrap gap-2">
        {state === "active" ? (
          <WithTooltip tip="Stop new sessions and assignments; leave running sessions alone">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              data-pw="repository-pause"
              onClick={() => operate("pause")}
            >
              Pause
            </Button>
          </WithTooltip>
        ) : (
          <WithTooltip tip="Allow new sessions and assignments again">
            <Button
              type="button"
              size="sm"
              disabled={pending || state === "draining"}
              data-pw="repository-activate"
              onClick={() => operate("activate")}
            >
              Activate
            </Button>
          </WithTooltip>
        )}
        {confirmDrain ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={pending}
              data-pw="repository-drain-confirm"
              onClick={() => operate("drain")}
            >
              Confirm cancel all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-pw="repository-drain-cancel"
              onClick={() => setConfirmDrain(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || state === "draining"}
            data-pw="repository-drain"
            onClick={() => setConfirmDrain(true)}
          >
            Drain…
          </Button>
        )}
      </div>
    </section>
  );
}
