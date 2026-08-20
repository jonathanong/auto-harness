"use client";

import { useTransition } from "react";
import { Button, Input, Label, showToast } from "@auto-harness/ui";

import type { UserAccountInput, UserAccountRole } from "./user-account-api.ts";

export function UserAccountCreateForm({
  onCreate,
}: {
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
        const input: UserAccountInput = {
          username: String(data.get("username") ?? "").trim(),
          password: String(data.get("password") ?? ""),
          role: String(data.get("role") ?? "operator") as UserAccountRole,
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
          <Label htmlFor="user-account-password">Initial password</Label>
          <Input
            id="user-account-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            data-pw="user-account-password"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="user-account-role">Role</Label>
          <select
            id="user-account-role"
            name="role"
            defaultValue="operator"
            className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            data-pw="user-account-role"
          >
            <option value="read-only">Read-only</option>
            <option value="operator">Operator</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
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
