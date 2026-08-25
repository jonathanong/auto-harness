"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@auto-harness/ui";

import type { ServiceAccountSecret } from "./service-account-api.ts";

export function ServiceAccountKeyDialog({
  secret,
  rotatedFromId,
  onDismiss,
  onRevokeOld,
}: {
  secret: ServiceAccountSecret;
  rotatedFromId?: string;
  onDismiss: () => void;
  onRevokeOld: (id: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent data-pw="service-account-key-dialog">
        <DialogHeader>
          <DialogTitle>Copy the API key now</DialogTitle>
          <DialogDescription data-pw="service-account-key-warning">
            This key is shown once. It cannot be recovered after this dialog closes.
          </DialogDescription>
        </DialogHeader>
        <code
          className="break-all rounded-sm bg-muted p-3 text-sm"
          data-pw="service-account-api-key"
        >
          {secret.apiKey}
        </code>
        <Button
          type="button"
          variant="outline"
          data-pw="service-account-copy-key"
          onClick={() => {
            void navigator.clipboard
              .writeText(secret.apiKey)
              .then(() => setCopied(true))
              .catch(() => setError("Unable to copy. Select and copy the key manually."));
          }}
        >
          Copy key
        </Button>
        {copied ? <p data-pw="service-account-copy-ok">Copied.</p> : null}
        {rotatedFromId ? (
          <div
            className="space-y-3 rounded-sm border border-amber-500 p-3"
            data-pw="rotation-warning"
          >
            <p className="text-sm">
              The old key remains active. Update every consumer before revoking it.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
                data-pw="rotation-consumers-updated"
              />
              I updated all consumers to use the new key.
            </label>
            <Button
              type="button"
              variant="destructive"
              disabled={!confirmed || pending}
              data-pw="rotation-revoke-old"
              onClick={() => {
                start(async () => {
                  setError(null);
                  try {
                    await onRevokeOld(rotatedFromId);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Unable to revoke old key.");
                  }
                });
              }}
            >
              {pending ? "Revoking…" : "Revoke old key"}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="button" onClick={onDismiss} data-pw="service-account-key-done">
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
