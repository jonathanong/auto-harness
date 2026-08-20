"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  WithTooltip,
} from "@auto-harness/ui";
import type { Provider } from "@auto-harness/shared";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export function EditProviderForm({ provider }: { provider: Provider }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-pw="edit-provider-open">
          Edit provider
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="edit-provider-dialog">
        <DialogHeader>
          <DialogTitle>Edit provider</DialogTitle>
          <DialogDescription>
            Rename this provider. Lowercase letters, numbers, and dashes only; unique.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          data-pw="form-edit-provider"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            const fd = new FormData(e.currentTarget);
            const name = String(fd.get("name") ?? "").trim();
            start(async () => {
              const res = await fetch(
                `${apiBase()}/api/v1/providers/${encodeURIComponent(provider.id)}`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name }),
                },
              );
              if (!res.ok) {
                setError(await apiErrorMessage(res));
                return;
              }
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="name" tip="Lowercase letters, numbers, and dashes only; unique">
              Name
            </Label>
            <Input
              id="name"
              name="name"
              defaultValue={provider.name}
              required
              data-pw="edit-provider-name"
            />
          </div>
          {error ? (
            <p className="text-sm text-red-700" data-pw="edit-provider-error">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <WithTooltip tip="Save changes to this provider">
              <Button type="submit" size="sm" disabled={pending} data-pw="edit-provider-submit">
                {pending ? "Saving…" : "Save"}
              </Button>
            </WithTooltip>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
