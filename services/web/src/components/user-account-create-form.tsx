"use client";

import { useTransition } from "react";
import type { UserRole } from "@auto-harness/shared";
import { Button, Input, Label, showToast } from "@auto-harness/ui";

import { RoleSelect } from "./role-select.tsx";
import type { RepositoryOption } from "./service-account-api.ts";
import type { UserAccountInput } from "./user-account-api.ts";

export function UserAccountCreateForm({
  repositories = [],
  onCreate,
}: {
  repositories?: RepositoryOption[];
  onCreate: (input: UserAccountInput) => Promise<void>;
}) {
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-4 border-b border-border pb-6"
      data-pw="form-user-account-create"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const allowedRepositoryIds = data.getAll("allowedRepositoryIds").map(String);
        const input: UserAccountInput = {
          username: String(data.get("username") ?? "").trim(),
          password: String(data.get("password") ?? ""),
          role: String(data.get("role") ?? "operator") as UserRole,
          ...(allowedRepositoryIds.length ? { allowedRepositoryIds } : {}),
        };
        start(async () => {
          try {
            await onCreate(input);
            form.reset();
          } catch (cause) {
            showToast(cause instanceof Error ? cause.message : "Unable to create user account.", {
              variant: "destructive",
              pw: "user-account-create-error",
            });
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="user-account-username">Username</Label>
          <Input
            id="user-account-username"
            name="username"
            autoComplete="username"
            required
            data-pw="user-account-username"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="user-account-password">Initial Password</Label>
          <Input
            id="user-account-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            data-pw="user-account-password"
          />
        </div>
        <RoleSelect id="user-account-role" pw="user-account-role" />
      </div>
      {repositories.length ? (
        <fieldset className="space-y-2" data-pw="user-account-repository-scope">
          <legend className="text-sm font-medium">Repository scope</legend>
          <p className="text-xs text-muted-foreground">
            No selection grants access to all repositories. Admin accounts cannot be scoped.
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
      ) : null}
      <p className="text-xs text-muted-foreground">
        Passwords are sent only when the account is created. Users can change their own password
        after signing in.
      </p>
      <Button type="submit" disabled={pending} data-pw="user-account-create-submit">
        {pending ? "Creating…" : "Create user account"}
      </Button>
    </form>
  );
}
