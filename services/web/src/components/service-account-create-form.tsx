"use client";

import { useTransition } from "react";
import { Button, Input, Label, showToast } from "@auto-harness/ui";

import type {
  RepositoryOption,
  ServiceAccountInput,
  ServiceAccountRole,
} from "./service-account-api.ts";
import { HostIdCombobox } from "./host-id-combobox.tsx";

export function ServiceAccountCreateForm({
  repositories,
  hostIds = [],
  onCreate,
}: {
  repositories: RepositoryOption[];
  hostIds?: string[];
  onCreate: (input: ServiceAccountInput) => Promise<void>;
}) {
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-4 border-b border-border pb-6"
      data-pw="form-service-account-create"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const allowedRepositoryIds = data.getAll("allowedRepositoryIds").map(String);
        const boundHostId = String(data.get("boundHostId") ?? "").trim();
        if (boundHostId && !hostIds.includes(boundHostId)) {
          showToast("Select a host from the list", {
            variant: "destructive",
            pw: "service-account-create-error",
          });
          return;
        }
        const input: ServiceAccountInput = {
          name: String(data.get("name") ?? "").trim(),
          role: String(data.get("role") ?? "operator") as ServiceAccountRole,
          ...(allowedRepositoryIds.length ? { allowedRepositoryIds } : {}),
          ...(boundHostId ? { boundHostId } : {}),
        };
        start(async () => {
          try {
            await onCreate(input);
            form.reset();
          } catch (cause) {
            showToast(
              cause instanceof Error ? cause.message : "Unable to create service account.",
              { variant: "destructive", pw: "service-account-create-error" },
            );
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="service-account-name">Name</Label>
          <Input id="service-account-name" name="name" required data-pw="service-account-name" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="service-account-role">Role</Label>
          <select
            id="service-account-role"
            name="role"
            defaultValue="operator"
            className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            data-pw="service-account-role"
          >
            <option value="read-only">Read-only</option>
            <option value="operator">Operator</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="service-account-bound-host">Bound Host ID (Optional)</Label>
        <HostIdCombobox
          id="service-account-bound-host"
          name="boundHostId"
          dataPw="service-account-bound-host"
          hostIds={hostIds}
        />
        <p className="text-xs text-muted-foreground">Required for host daemon credentials.</p>
      </div>
      <fieldset className="space-y-2" data-pw="service-account-repository-scope">
        <legend className="text-sm font-medium">Repository Scope</legend>
        <p className="text-xs text-muted-foreground">
          No selection grants access to all repositories.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {repositories.map((repository) => (
            <label key={repository.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="allowedRepositoryIds" value={repository.id} />
              {repository.name}
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" disabled={pending} data-pw="service-account-create-submit">
        {pending ? "Creating…" : "Create service account"}
      </Button>
    </form>
  );
}
