import { Input, Label } from "@auto-harness/ui";

import type { SessionCloneDraft } from "../session-clone-draft.ts";

export function SessionCreateDetailFields({
  initialValues,
}: {
  initialValues?: SessionCloneDraft | null;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="timeout" tip="Max runtime in seconds before the session is timed out">
            Timeout (s)
          </Label>
          <Input
            id="timeout"
            name="timeout"
            type="number"
            defaultValue={initialValues?.timeout ?? 600}
            step="any"
            data-pw="create-session-timeout"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ref" tip="Git ref to check out in the worktree (branch, tag, or SHA)">
            Git ref
          </Label>
          <Input
            id="ref"
            name="ref"
            placeholder="main"
            defaultValue={initialValues?.ref}
            data-pw="create-session-ref"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="queueTtlSeconds"
          tip="Absolute maximum time a queued session may wait; it is not reset by retries"
        >
          Queue TTL (s)
        </Label>
        <Input
          id="queueTtlSeconds"
          name="queueTtlSeconds"
          type="number"
          defaultValue={initialValues?.queueTtlSeconds ?? 691200}
          min={1}
          data-pw="create-session-queue-ttl"
        />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="concurrencyId"
          tip="Optional stable ID that prevents duplicate queued or running work"
        >
          Concurrency ID
        </Label>
        <Input
          id="concurrencyId"
          name="concurrencyId"
          placeholder="filaments-pr-shepherd-123"
          data-pw="create-session-concurrency-id"
        />
        <p className="text-xs text-muted-foreground">
          Repeated requests with this ID reuse the active session; a new one can be queued after it
          finishes.
        </p>
      </div>
    </>
  );
}
