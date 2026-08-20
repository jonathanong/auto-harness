"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label, dismissToast, showToast } from "@auto-harness/ui";
import { apiErrorMessage } from "@auto-harness/shared";

import { apiFetch } from "../lib/client-api.ts";

export function ChangePasswordForm() {
  const [pending, start] = useTransition();
  const [success, setSuccess] = useState(false);

  return (
    <form
      className="space-y-4"
      data-pw="form-change-password"
      onSubmit={(event) => {
        event.preventDefault();
        dismissToast();
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
            showToast(await apiErrorMessage(response), {
              variant: "destructive",
              pw: "change-password-error",
            });
            return;
          }
          formElement.reset();
          dismissToast();
          setSuccess(true);
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="currentPassword">Current password</Label>
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
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          data-pw="change-password-new"
        />
      </div>
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
