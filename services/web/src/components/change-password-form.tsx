"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";

export function ChangePasswordForm() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  return (
    <form
      className="space-y-4"
      data-pw="form-change-password"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSuccess(false);
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const currentPassword = String(form.get("currentPassword") ?? "");
        const newPassword = String(form.get("newPassword") ?? "");
        start(async () => {
          const response = await apiFetch(
            "/api/v1/auth/password",
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ currentPassword, newPassword }),
            },
            { redirectOnUnauthorized: false },
          );
          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            setError(payload?.error?.message ?? "Unable to change password.");
            return;
          }
          formElement.reset();
          setSuccess(true);
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="currentPassword">Current Password</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          data-pw="change-password-current"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="newPassword">New Password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          data-pw="change-password-new"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="change-password-error">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="text-sm text-emerald-700" data-pw="change-password-ok">
          Password changed.
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-pw="change-password-submit">
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
